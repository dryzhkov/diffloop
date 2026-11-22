import type { AgentResource, AgentScope, CodeAnchor, FileContent, Review, ReviewContext } from './api';
import { anchorFor, parseLines } from './diff-lines';

interface ContextEntry extends AgentResource {
  read(): string | Promise<string>;
}

export function anchorRows(review: Review, anchor: CodeAnchor) {
  const diff = review.diff.data;
  if (!anchor || typeof anchor.path !== 'string' || anchor.path.length > 4096 || !['base', 'head'].includes(anchor.side) ||
      !Number.isSafeInteger(anchor.startLine) || !Number.isSafeInteger(anchor.endLine) ||
      anchor.startLine < 1 || anchor.endLine < anchor.startLine || !diff?.diffBaseSha ||
      anchor.commitSha !== (anchor.side === 'base' ? diff.diffBaseSha : diff.headSha)) {
    throw new Error('Invalid review anchor');
  }
  const file = diff.files.find(f => (anchor.side === 'base' ? f.previousPath ?? f.path : f.path) === anchor.path);
  if (!file?.patch) throw new Error('Anchor patch unavailable');
  const rows = parseLines(file.patch);
  const first = rows.find(r => r[anchor.side] === anchor.startLine);
  const last = rows.find(r => r[anchor.side] === anchor.endLine);
  if (!first || !last || !first.hunk || !anchorFor(diff, file, anchor.side, first, last)) throw new Error('Anchor is outside a cached hunk');
  return rows.filter(r => r.hunk === first.hunk && r[anchor.side] !== undefined &&
    r[anchor.side]! >= anchor.startLine && r[anchor.side]! <= anchor.endLine)
    .map(r => ({ line: r[anchor.side]!, text: r.text.slice(1) }));
}

export function agentContext(review: Review, scope: AgentScope, allowed: ReviewContext[],
  readFile: (file: FileContent) => Promise<string>) {
  const entries = new Map<string, ContextEntry>();
  const meta = review.metadata.data;
  if (!meta || !review.metadata.complete) throw new Error('Pull PR metadata before reviewing');
  const revision = meta.baseSha + ':' + meta.headSha;
  const fresh = (resource: Review[keyof Review]) => resource.complete && resource.revision === revision;
  if (!fresh(review.metadata)) throw new Error('PR metadata revision unavailable');
  const diff = fresh(review.diff) && review.diff.data?.headSha === meta.headSha &&
    review.diff.data.baseSha === meta.baseSha ? review.diff.data : null;

  function add(kind: ReviewContext, key: string, revision: string, read: ContextEntry['read']) {
    if (allowed.includes(kind)) entries.set(key, { key, kind, revision, source: 'github', read });
  }
  if (scope.kind === 'selection') {
    if (!allowed.includes('diff') || !diff) throw new Error('Current diff selection is unavailable or outside the grant');
    const rows = anchorRows(review, scope.anchor);
    add('diff', 'selection', scope.anchor.commitSha, () => JSON.stringify({ anchor: scope.anchor, rows }));
  } else if (scope.kind === 'thread') {
    const thread = fresh(review.threads) && review.threads.data?.find(t => t.id === scope.thread);
    if (!allowed.includes('review_threads') || !thread) throw new Error('Current thread is unavailable or outside the grant');
    add('review_threads', 'thread', revision, () => JSON.stringify(thread));
  } else {
    add('pr_description', 'description', revision, () => JSON.stringify({ title: meta.title, body: meta.body }));
    if (diff?.diffBaseSha) for (const file of diff.files) {
      if (file.patch && !file.patchError) add('diff', 'diff:' + file.path, diff.diffBaseSha + ':' + meta.headSha,
        () => JSON.stringify({ path: file.path, previousPath: file.previousPath, patch: file.patch }));
    }
    if (diff?.diffBaseSha && fresh(review.files)) for (const file of review.files.data ?? []) {
      const sha = file.side === 'base' ? diff.diffBaseSha : meta.headSha;
      if (file.sha === sha && file.blob && !file.error) add('changed_files', 'file:' + file.side + ':' + file.path, sha, () => readFile(file));
    }
    if (fresh(review.threads)) for (const thread of review.threads.data ?? []) {
      add('review_threads', 'thread:' + thread.id, revision, () => JSON.stringify(thread));
    }
    for (const kind of ['comments', 'reviews'] as const) {
      if (fresh(review[kind])) add('review_threads', kind, revision, () => JSON.stringify(review[kind].data));
    }
  }
  if (!entries.size) throw new Error('No granted cached context is available for this scope');
  return { entries, meta, diff };
}
