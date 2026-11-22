import { reconcile, observeRequests, type RequestTargets } from './attention';
import { agents } from './agents';
import { publishing } from './publishing';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Connection, FileContent, Metadata, PullResult, Resource, Review, SavedQuery, WorkspaceStatus } from './api';
import { fetchComments, fetchReviews, fetchThreads, GitHub, GitHubError } from './github';
import { fetchDiff, fileReader, isRepository, isSha, message } from './revisions';

interface Vault {
  available(): boolean | Promise<boolean>;
  encrypt(token: string): Promise<Uint8Array>;
  forget(ref: string): void;
  read(ref: string): string | undefined | Promise<string | undefined>;
  save(ref: string, ciphertext: Uint8Array): void;
}
interface Account { id: string; credential_ref: string; status: Connection['status'] }
interface Target {
  id: string; remote_id: string; repository: string; number: number;
}
interface SearchPage {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{ id: number; node_id: string; number: number; repository_url: string; pull_request?: object }>;
}
interface RemotePR extends RequestTargets {
  node_id: string; number: number; state: string; merged: boolean; draft: boolean;
  title: string; body: string | null; user: { login: string } | null; html_url: string; updated_at: string;
  base: { sha: string; repo: { id: number; full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
  changed_files: number;
}

const updateResource = `
  INSERT INTO pull_resources (pr_id, kind, data, cached_at, revision, error, complete) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (pr_id, kind) DO UPDATE SET data = excluded.data, cached_at = excluded.cached_at,
    revision = excluded.revision, error = excluded.error, complete = excluded.complete
`;

export function workspace(db: DatabaseSync, vault: Vault, cacheRoot: string, request = fetch) {
  const pulling = new Map<string, { controller: AbortController; progress: string }>();

  function transaction(action: () => void) {
    db.exec('BEGIN IMMEDIATE');
    try {
      action();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function account(id: string) {
    const row = db.prepare('SELECT id, credential_ref, status FROM connections WHERE id = ?').get(id);
    if (!row) throw new Error('GitHub connection not found');
    return row as unknown as Account;
  }

  function resource<T>(id: string, kind: keyof Review): Resource<T> {
    const row = db.prepare('SELECT data, cached_at, revision, error, complete FROM pull_resources WHERE pr_id = ? AND kind = ?')
      .get(id, kind) as { data: string | null; cached_at: string | null; revision: string | null; error: string | null; complete: number } | undefined;
    return { data: row?.data ? JSON.parse(row.data) : null, cachedAt: row?.cached_at ?? null,
      revision: row?.revision ?? null, error: row?.error ?? null, complete: row?.complete === 1 };
  }

  function save(id: string, kind: keyof Review, data: unknown, revision: string, error: string | null = null) {
    db.prepare(updateResource).run(id, kind, JSON.stringify(data), new Date().toISOString(), revision, error, error ? 0 : 1);
  }

  function failure(id: string, kind: keyof Review, error: string) {
    db.prepare(`INSERT INTO pull_resources (pr_id, kind, error) VALUES (?, ?, ?)
      ON CONFLICT (pr_id, kind) DO UPDATE SET error = excluded.error`).run(id, kind, error);
  }

  function queries(id?: string) {
    const sql = 'SELECT id, connection_id AS connectionId, query FROM saved_queries';
    return (id ? db.prepare(`${sql} WHERE connection_id = ? ORDER BY rowid`).all(id) :
      db.prepare(`${sql} ORDER BY rowid`).all()) as unknown as SavedQuery[];
  }

  function cacheDir(connectionId: string) {
    return join(cacheRoot, connectionId);
  }

  async function refresh(github: GitHub, connectionId: string, target: Target, read: ReturnType<typeof fileReader>, progress: (stage: string) => void, signal: AbortSignal, discoveryComplete: boolean) {
    const problems: string[] = [];
    const locate = (repository: string) => `/repos/${repository}/pulls/${target.number}`;
    let pr = locate(target.repository);
    const getPR = async () => {
      const { data } = await github.get<RemotePR>(pr);
      if (data?.node_id !== target.remote_id || data.number !== target.number ||
        !isSha(data.base?.sha) || !isSha(data.head?.sha) || !isRepository(data.base?.repo?.full_name) ||
        !Number.isSafeInteger(data.base.repo.id) || !Number.isSafeInteger(data.changed_files) || data.changed_files < 0 ||
        !['open', 'closed'].includes(data.state) || typeof data.merged !== 'boolean' || typeof data.title !== 'string' ||
        typeof data.updated_at !== 'string') throw new Error('Invalid or mismatched GitHub PR metadata');
      return data;
    };

    let remote: RemotePR;
    try {
      try {
        remote = await getPR();
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof GitHubError) || ![301, 302, 404].includes(error.status)) throw error;
        const { data } = await github.get<{ data?: { node?: { number: number; repository: { nameWithOwner: string } } } }>(
          '/graphql', { query: 'query($id:ID!) { node(id:$id) { ... on PullRequest { number repository { nameWithOwner } } } }',
            variables: { id: target.remote_id } });
        const node = data.data?.node;
        if (!node || node.number !== target.number || !isRepository(node.repository?.nameWithOwner) ||
          node.repository.nameWithOwner === target.repository) throw error;
        pr = locate(node.repository.nameWithOwner);
        remote = await getPR();
      }
    } catch (error) {
      signal.throwIfAborted();
      failure(target.id, 'metadata', message(error));
      throw error;
    }

    const repository = remote.base.repo.full_name;
    pr = locate(repository);
    const root = `/repos/${repository}`;
    const headRepository = isRepository(remote.head.repo?.full_name) ? remote.head.repo.full_name : null;
    const metadata: Metadata = {
      title: remote.title, body: remote.body, author: remote.user?.login ?? null, url: remote.html_url,
      repositoryId: String(remote.base.repo.id), state: remote.merged ? 'merged' : remote.state as 'open' | 'closed',
      isDraft: remote.draft, updatedAt: remote.updated_at, baseSha: remote.base.sha, headSha: remote.head.sha,
    };
    const revision = `${metadata.baseSha}:${metadata.headSha}`;
    transaction(() => {
      db.prepare('UPDATE pull_requests SET repository = ?, state = ? WHERE id = ?').run(repository, metadata.state, target.id);
      save(target.id, 'metadata', metadata, revision);
    });

    try {
      const diff = await fetchDiff(github, root, pr, metadata.baseSha, metadata.headSha, headRepository, remote.changed_files,
        async () => {
          const latest = await getPR();
          if (latest.base.sha !== metadata.baseSha || latest.head.sha !== metadata.headSha ||
            latest.changed_files !== remote.changed_files || latest.updated_at !== remote.updated_at) {
            throw new Error('PR changed during diff pagination. Pull again to refresh its revision.');
          }
        });
      const files: FileContent[] = [];
      const dir = cacheDir(connectionId);
      const hasBlob = (sha: string) => access(join(dir, sha)).then(() => true, () => false);
      const saveBlob = async (sha: string, content: string) => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const temporary = join(dir, `${sha}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, content, { mode: 0o600, flush: true });
          await rename(temporary, join(dir, sha));
        } finally {
          await rm(temporary, { force: true });
        }
      };
      for (const [index, file] of diff.data.files.entries()) {
        signal.throwIfAborted();
        progress(`File ${index + 1} of ${diff.data.files.length}`);
        if (file.status !== 'added' && file.status !== 'copied' || file.previousPath) {
          const path = file.previousPath ?? file.path;
          files.push(diff.data.diffBaseSha ? await read(repository, 'base', diff.data.diffBaseSha, path, hasBlob, saveBlob) :
            { path, side: 'base', sha: null, error: 'PR diff base unavailable' });
        }
        if (file.status !== 'removed') {
          files.push(headRepository ? await read(headRepository, 'head', metadata.headSha, file.path, hasBlob, saveBlob) :
            { path: file.path, side: 'head', sha: metadata.headSha, error: 'Head repository unavailable' });
        }
      }
      signal.throwIfAborted();
      const fileErrors = files.filter(file => file.error).length;
      const contentsError = [fileErrors ? `${fileErrors} file versions unavailable` : null,
        !diff.inventoryComplete ? 'Changed-file list incomplete' : null].filter(Boolean).join('. ') || null;
      transaction(() => {
        const previous = resource<Review['diff']['data']>(target.id, 'diff');
        if (diff.error && previous.data && previous.complete && previous.revision === revision) {
          failure(target.id, 'diff', diff.error);
          failure(target.id, 'files', contentsError ?? 'Latest diff could not be fully refreshed');
          return;
        }
        const priorFiles = resource<FileContent[]>(target.id, 'files').data ?? [];
        const blobs = new Map(priorFiles.filter(file => file.blob)
          .map(file => [JSON.stringify([file.side, file.sha, file.path]), file]));
        const retained = files.map(file => file.error ?
          blobs.get(JSON.stringify([file.side, file.sha, file.path])) ?? file : file);
        save(target.id, 'diff', diff.data, revision, diff.error);
        save(target.id, 'files', retained, revision, contentsError);
      });
      if (diff.error) problems.push(`Diff: ${diff.error}`);
      if (contentsError) problems.push(`Contents: ${contentsError}`);
    } catch (error) {
      signal.throwIfAborted();
      failure(target.id, 'diff', message(error));
      failure(target.id, 'files', 'Diff could not be refreshed');
      problems.push(`Diff: ${message(error)}`);
    }

    const discussion = [
      ['comments', () => fetchComments(github, root, target.number)],
      ['reviews', () => fetchReviews(github, root, target.number)],
      ['threads', () => fetchThreads(github, target.remote_id)],
    ] as const;
    const downloaded: Array<{ kind: typeof discussion[number][0]; data: unknown }> = [];
    for (const [kind, download] of discussion) {
      signal.throwIfAborted();
      progress(kind);
      try {
        downloaded.push({ kind, data: await download() });
      } catch (error) {
        signal.throwIfAborted();
        failure(target.id, kind, message(error));
        problems.push(`${kind}: ${message(error)}`);
      }
    }
    if (downloaded.length) {
      try {
        const login = String(db.prepare('SELECT login FROM connections WHERE id=?').get(connectionId)?.login).toLowerCase();
        let requests: Awaited<ReturnType<typeof observeRequests>> | undefined;
        if (discoveryComplete && !problems.length && metadata.state === 'open') {
          try { requests = await observeRequests(github, root + '/issues/' + target.number, remote, login); }
          catch (error) { problems.push('Attention: ' + message(error)); }
        }
        const latest = await getPR();
        if (latest.updated_at !== remote.updated_at || latest.head.sha !== metadata.headSha || latest.base.sha !== metadata.baseSha) {
          throw new Error('PR changed while downloading discussion. Pull again to refresh it.');
        }
        transaction(() => {
          for (const { kind, data } of downloaded) save(target.id, kind, data, revision);
          if (requests && !signal.aborted) reconcile(db, target.id, metadata.headSha, requests,
            resource<NonNullable<Review['threads']['data']>>(target.id, 'threads').data!,
            resource<NonNullable<Review['reviews']['data']>>(target.id, 'reviews').data!, login, metadata.author);
        });
      } catch (error) {
        signal.throwIfAborted();
        for (const { kind } of downloaded) failure(target.id, kind, message(error));
        problems.push(`Discussion: ${message(error)}`);
      }
    }
    return problems;
  }

  function review(id: string): Review {
      if (!db.prepare('SELECT 1 FROM pull_requests WHERE id = ?').get(id)) throw new Error('Pull request not found');
      return { metadata: resource(id, 'metadata'), diff: resource(id, 'diff'), files: resource(id, 'files'),
        comments: resource(id, 'comments'), reviews: resource(id, 'reviews'), threads: resource(id, 'threads') };
    }
  async function cachedFile(id: string, path: string, side: FileContent['side'], blob: string) {
    const row = db.prepare('SELECT connection_id FROM pull_requests WHERE id = ?').get(id);
    const file = resource<FileContent[]>(id, 'files').data?.find(item => item.path === path && item.side === side);
    if (!row || !isSha(file?.blob)) throw new Error(file?.error ?? 'File is not cached');
    if (file.blob !== blob) throw new Error('File snapshot changed. Reopen the pull request to view its latest cache.');
    return readFile(join(cacheDir(String(row.connection_id)), file.blob), 'utf8').catch(() => {
      throw new Error('Cached file could not be read');
    });
  }
  const reviewer = agents(db, review, (pr, file) => cachedFile(pr, file.path, file.side, file.blob!));
  const publisher = publishing(db, review, async (connectionId, signal) => {
    const connection = account(connectionId);
    if (connection.status === 'disconnected') throw new Error('Account disconnected');
    const token = await vault.read(connection.credential_ref);
    if (!token) throw new Error('Connect your GitHub account');
    return new GitHub(token, request, signal);
  });
  return {
    ...publisher,
    ...reviewer,
    async status(): Promise<WorkspaceStatus> {
      const connections = db.prepare('SELECT id, login, status, last_pulled_at AS lastPulledAt FROM connections ORDER BY login')
        .all() as unknown as Connection[];
      const pullRequests = db.prepare(`SELECT p.id, p.connection_id AS connectionId, p.repository, p.number, p.state,
        json_extract(r.data, '$.title') AS title FROM pull_requests p
        LEFT JOIN pull_resources r ON r.pr_id = p.id AND r.kind = 'metadata'
        ORDER BY p.state = 'open' DESC, json_extract(r.data, '$.updatedAt') DESC, p.repository, p.number`).all() as unknown as WorkspaceStatus['pullRequests'];
      for (const pr of pullRequests) {
        const state = db.prepare('SELECT snoozed FROM attention_state WHERE pr_id=?').get(pr.id);
        pr.attentionReady = !!state;
        pr.snoozed = !!state?.snoozed;
        pr.reasons = db.prepare('SELECT event_key AS key, kind FROM attention_events WHERE pr_id=? AND active=1 AND acknowledged=0')
          .all(pr.id) as unknown as typeof pr.reasons;
      }
      return { accounts: connections.length, credentialStorageAvailable: await vault.available(), connections, queries: queries(), pullRequests };
    },

    async connect(token: string, signal?: AbortSignal) {
      if (!await vault.available()) throw new Error('OS credential encryption unavailable');
      const { data } = await new GitHub(token, request, signal).get<{ id: number; login: string }>('/user');
      if (!Number.isSafeInteger(data?.id) || typeof data.login !== 'string' || !data.login) throw new Error('GitHub account identity unavailable');
      const ciphertext = await vault.encrypt(token);
      signal?.throwIfAborted();
      const accountId = String(data.id);
      const existing = db.prepare('SELECT id, credential_ref FROM connections WHERE account_id = ?').get(accountId);
      const id = existing ? String(existing.id) : randomUUID();
      if (pulling.has(id)) throw new Error('Wait for Pull to finish before replacing this token');
      const ref = existing ? String(existing.credential_ref) : randomUUID();
      transaction(() => {
        vault.save(ref, ciphertext);
        db.prepare(`INSERT INTO connections (id, account_id, login, credential_ref) VALUES (?, ?, ?, ?)
          ON CONFLICT (account_id) DO UPDATE SET login = excluded.login, status = 'connected'`).run(id, accountId, data.login, ref);
      });
    },

    disconnect(id: string) {
      publisher.cancel(id);
      reviewer.cancelConnection(id);
      const connection = account(id);
      transaction(() => {
        vault.forget(connection.credential_ref);
        db.prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?").run(id);
      });
      pulling.get(id)?.controller.abort();
    },

    saveQuery(connectionId: string, query: string, id?: string) {
      account(connectionId);
      if (id) {
        const changed = db.prepare('UPDATE saved_queries SET query = ? WHERE id = ? AND connection_id = ?').run(query, id, connectionId);
        if (!changed.changes) throw new Error('Saved query not found for this connection');
      } else {
        db.prepare('INSERT INTO saved_queries VALUES (?, ?, ?) ON CONFLICT (connection_id, query) DO NOTHING')
          .run(randomUUID(), connectionId, query);
      }
    },

    deleteQuery(id: string) {
      db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id);
    },

    markHandled(id: string, keys: string[]) {
      transaction(() => {
        const ack = db.prepare('UPDATE attention_events SET acknowledged=1 WHERE pr_id=? AND event_key=?');
        for (const key of keys) ack.run(id, key);
      });
    },
    snooze(id: string) {
      if (!db.prepare('UPDATE attention_state SET snoozed=1 WHERE pr_id=?').run(id).changes) {
        throw new Error('Pull this PR before snoozing it');
      }
    },
    pullProgress(id: string) { return pulling.get(id)?.progress ?? null; },
    cancelPull(id: string) { pulling.get(id)?.controller.abort(); },

    async pull(id: string, prId?: string): Promise<PullResult> {
      const connection = account(id);
      if (pulling.has(id)) throw new Error('Pull is already running for this connection');
      if (connection.status === 'disconnected') throw new Error('Connect this account before pulling');
      const selected = prId ? db.prepare('SELECT * FROM pull_requests WHERE connection_id = ? AND id = ?').get(id, prId) as unknown as Target | undefined : undefined;
      if (prId && !selected) throw new Error('Pull request not found for this connection');
      const cancellation = new AbortController();
      const activity = { controller: cancellation, progress: 'Reading account credentials…' };
      pulling.set(id, activity);
      const errors: string[] = [];
      let refreshed = 0;
      let status: Connection['status'] = 'connected';
      try {
        const token = await vault.read(connection.credential_ref);
        if (cancellation.signal.aborted) throw new Error('Pull cancelled');
        if (!token) throw new GitHubError('GitHub token unavailable. Connect the account again.', 401);
        const github = new GitHub(token, request, cancellation.signal);
        const read = fileReader(github);
        const targets = new Map<string, Target>();
        const tracked = selected ? [selected] :
          db.prepare("SELECT * FROM pull_requests WHERE connection_id = ? AND state = 'open'").all(id) as unknown as Target[];
        for (const target of tracked) {
          targets.set(target.remote_id, target);
        }
        for (const { query } of selected ? [] : queries(id)) {
          if (cancellation.signal.aborted || github.stopped) break;
          activity.progress = `Searching saved queries · ${targets.size} PRs queued`;
          try {
            let expected = 0;
            let incomplete = false;
            const seen = new Set<number>();
            const search = `/search/issues?per_page=100&q=${encodeURIComponent(`${query} is:pr`)}`;
            for await (const item of github.pages(search, page => {
              const { total_count, incomplete_results, items } = page as SearchPage;
              if (!Number.isSafeInteger(total_count) || typeof incomplete_results !== 'boolean') {
                throw new Error('Invalid GitHub search page');
              }
              expected = Math.max(expected, total_count);
              incomplete ||= incomplete_results;
              return items;
            })) {
              const prefix = 'https://api.github.com/repos/';
              const repository = typeof item?.repository_url === 'string' && item.repository_url.startsWith(prefix)
                ? item.repository_url.slice(prefix.length) : null;
              if (!item?.pull_request || !isRepository(repository) || !Number.isSafeInteger(item.id) ||
                !Number.isSafeInteger(item.number) || item.number <= 0 || typeof item.node_id !== 'string' || !item.node_id) {
                incomplete = true;
                continue;
              }
              seen.add(item.id);
              const target = db.prepare(`INSERT INTO pull_requests (id, connection_id, remote_id, repository, number)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(connection_id, remote_id) DO UPDATE SET
                repository = excluded.repository, number = excluded.number RETURNING *`)
                .get(randomUUID(), id, item.node_id, repository, item.number) as unknown as Target;
              targets.set(target.remote_id, target);
              activity.progress = `Searching saved queries · ${targets.size} PRs queued`;
            }
            if (incomplete || seen.size !== expected) {
              throw new Error(`Discovery incomplete (${seen.size} of ${expected}; GitHub search returns at most 1,000 results per query)`);
            }
          } catch (error) {
            if (error instanceof GitHubError && error.status === 401) status = 'reauth_required';
            errors.push(`Query “${query}”: ${message(error)}`);
          }
        }
        const discoveryComplete = errors.length === 0;
        let position = 0;
        for (const target of targets.values()) {
          if (cancellation.signal.aborted || github.stopped) break;
          position++;
          const label = `${target.repository} #${target.number}`;
          try {
            const progress = (stage: string) => { activity.progress = `PR ${position} of ${targets.size} · ${label} · ${stage}`; };
            progress('Fetching metadata and diff');
            const problems = await refresh(github, id, target, read, progress, cancellation.signal, discoveryComplete);
            cancellation.signal.throwIfAborted();
            refreshed++;
            errors.push(...problems.map(problem => `${label} · ${problem}`));
          } catch (error) {
            if (error instanceof GitHubError && error.status === 401) status = 'reauth_required';
            errors.push(`${label} · Metadata: ${message(error)}`);
          }
        }
        if (github.authenticationFailed) status = 'reauth_required';
      } catch (error) {
        status = error instanceof GitHubError && error.status === 401 ? 'reauth_required' : 'error';
        errors.push(message(error));
      } finally {
        if (status === 'connected' && errors.length) status = 'error';
        pulling.delete(id);
        if (!cancellation.signal.aborted) {
          db.prepare('UPDATE connections SET status = ?, last_pulled_at = ? WHERE id = ?')
            .run(status, new Date().toISOString(), id);
        }
      }
      return cancellation.signal.aborted ? { refreshed, errors: ['Pull cancelled.', ...errors] } : { refreshed, errors };
    },

    review,

    readFile: cachedFile,
  };
}
