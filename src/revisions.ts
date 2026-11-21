import { createHash } from 'node:crypto';
import type { Diff, DiffFile, FileContent } from './api';
import type { GitHub } from './github';

export const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isRepository = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');

interface RemoteFile {
  filename: string;
  previous_filename?: string;
  sha: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

function validPatch(file: RemoteFile) {
  if (!file.patch) return false;
  let additions = 0;
  let deletions = 0;
  let oldLines = 0;
  let newLines = 0;
  let hunk = false;
  for (const line of file.patch.replace(/\n$/, '').split('\n')) {
    const header = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (header) {
      if (oldLines || newLines) return false;
      oldLines = Number(header[1] ?? 1);
      newLines = Number(header[2] ?? 1);
      hunk = true;
    } else if (line.startsWith('+')) {
      additions++;
      newLines--;
    } else if (line.startsWith('-')) {
      deletions++;
      oldLines--;
    } else if (line.startsWith(' ')) {
      oldLines--;
      newLines--;
    } else if (line !== '\\ No newline at end of file') {
      return false;
    }
    if (oldLines < 0 || newLines < 0) return false;
  }
  return hunk && !oldLines && !newLines && additions === file.additions && deletions === file.deletions;
}

export async function fetchDiff(github: GitHub, root: string, pr: string, baseSha: string, headSha: string,
  headRepository: string | null, expected: number, verifyRevision: () => Promise<void>) {
  const listed = new Map<string, RemoteFile>();
  const problems: string[] = [];
  try {
    for await (const file of github.pages<RemoteFile>(`${pr}/files?per_page=100`, data => data as RemoteFile[])) {
      if (typeof file?.filename !== 'string' || !file.filename || listed.has(file.filename) ||
        typeof file.status !== 'string' || (file.previous_filename !== undefined && typeof file.previous_filename !== 'string') ||
        (file.patch !== undefined && typeof file.patch !== 'string') ||
        !Number.isSafeInteger(file.additions) || !Number.isSafeInteger(file.deletions)) {
        throw new Error('Invalid or duplicate PR file in GitHub response');
      }
      listed.set(file.filename, file);
    }
  } catch (error) {
    problems.push(message(error));
  }
  if (listed.size !== expected) problems.push(`Received ${listed.size} of ${expected} changed files (GitHub caps this list at 3,000)`);
  const inventoryComplete = problems.length === 0;
  await verifyRevision();
  const files: DiffFile[] = Array.from(listed.values(), file => {
    const { filename: path, previous_filename: previousPath, status } = file;
    if (validPatch(file)) return { path, previousPath, status, patch: file.patch! };
    const patchError = file.patch ? 'Incomplete patch' : 'No text patch supplied (binary, oversized, or metadata-only change)';
    return { path, previousPath, status, patch: null, patchError };
  });
  if (files.some(file => file.patchError)) problems.push('Some files have missing or incomplete patches');

  let diffBaseSha: string | null = null;
  try {
    if (!headRepository) throw new Error('Head repository unavailable');
    const owner = headRepository.split('/')[0];
    const compare = `${root}/compare/${baseSha}...${encodeURIComponent(`${owner}:${headSha}`)}?per_page=1`;
    const { data } = await github.get<{ merge_base_commit?: { sha: string }; files?: RemoteFile[] }>(compare);
    if (!isSha(data.merge_base_commit?.sha) || !Array.isArray(data.files) || data.files.length >= 300 ||
      data.files.length !== expected || listed.size !== expected ||
      !data.files.every(file => {
        const original = listed.get(file.filename);
        return original && original.sha === file.sha && original.previous_filename === file.previous_filename &&
          original.status === file.status && original.additions === file.additions &&
          original.deletions === file.deletions && original.patch === file.patch;
      }) || new Set(data.files.map(file => file.filename)).size !== expected) {
      throw new Error('The immutable comparison could not be matched to the PR file list');
    }
    diffBaseSha = data.merge_base_commit.sha;
  } catch (error) {
    problems.push(`Diff base unavailable. ${message(error)}`);
  }
  const data: Diff = { baseSha, headSha, diffBaseSha, files };
  return { data, inventoryComplete, error: problems.join('. ') || null };
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error';
}

interface TreeEntry { path: string; sha: string; type: string; mode: string; size?: number }
const maxFileBytes = 512 * 1024;

export function fileReader(github: GitHub) {
  const trees = new Map<string, Promise<TreeEntry[]>>();
  const commits = new Map<string, Promise<string>>();
  return async (repository: string, side: FileContent['side'], revision: string, path: string,
    cached: (sha: string) => Promise<boolean>, save: (sha: string, text: string) => Promise<void>): Promise<FileContent> => {
    const file = { path, side, sha: revision };
    let entry: TreeEntry | undefined;
    try {
      const key = `${repository}/git/commits/${revision}`;
      let commit = commits.get(key);
      if (!commit) {
        commit = github.get<{ sha: string; tree: { sha: string } }>(`/repos/${key}`).then(({ data }) => {
          if (data.sha !== revision || !isSha(data.tree?.sha)) throw new Error('Git commit unavailable');
          return data.tree.sha;
        });
        commits.set(key, commit);
      }
      let tree = await commit;
      for (const part of path.split('/')) {
        if (!isSha(tree)) throw new Error('Revision tree unavailable');
        const key = `${repository}/git/trees/${tree}`;
        let lookup = trees.get(key);
        if (!lookup) {
          lookup = github.get<{ tree: TreeEntry[]; truncated: boolean }>(`/repos/${key}`).then(({ data }) => {
            if (data.truncated || !Array.isArray(data.tree)) throw new Error('Revision tree is incomplete');
            return data.tree;
          });
          trees.set(key, lookup);
        }
        entry = (await lookup).find(item => item.path === part);
        if (!entry) throw new Error('Path unavailable at this revision');
        tree = entry.sha;
      }
      if (entry?.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !isSha(entry.sha)) throw new Error('Path is not a regular Git blob');
      if (entry.size === undefined || entry.size > maxFileBytes) throw new Error('File exceeds the 512 KiB cache limit or has unknown size');
      if (!await cached(entry.sha)) {
        const { data } = await github.get<{ encoding: string; content: string; sha: string; size: number }>(
          `/repos/${repository}/git/blobs/${entry.sha}`);
        if (data.encoding !== 'base64' || data.sha !== entry.sha || data.size !== entry.size) throw new Error('Git blob unavailable');
        const bytes = Buffer.from(data.content, 'base64');
        const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (bytes.length !== entry.size || hash !== entry.sha) throw new Error('Git blob did not match its immutable SHA');
        if (bytes.includes(0)) throw new Error('Binary file');
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new Error('Binary or non-UTF-8 file');
        }
        await save(entry.sha, content);
      }
      return { ...file, blob: entry.sha };
    } catch (error) {
      return { ...file, error: message(error) };
    }
  };
}
