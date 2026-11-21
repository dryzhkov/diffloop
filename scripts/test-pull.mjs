import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'diffloop-pull-'));
const database = join(directory, 'workspace.sqlite');
let db;
try {
  for (const name of ['workspace', 'store']) {
    await build({ entryPoints: [`src/${name}.ts`], outfile: join(directory, `${name}.mjs`), bundle: true,
      platform: 'node', format: 'esm' });
  }
  const { openStore } = await import(join(directory, 'store.mjs'));
  const { workspace } = await import(join(directory, 'workspace.mjs'));
  const fresh = openStore(':memory:');
  assert.equal(fresh.prepare('PRAGMA user_version').get().user_version, 2);
  fresh.close();
  db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE credentials (ref TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);
    CREATE TABLE connections (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL,
      credential_ref TEXT NOT NULL UNIQUE REFERENCES credentials(ref)
    );
    INSERT INTO credentials VALUES ('legacy-ref', X'6C6567616379');
    INSERT INTO connections VALUES ('legacy-id', '1', 'legacy', 'legacy-ref');
    PRAGMA user_version = 1;
  `);
  db.close();
  db = openStore(database);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare("SELECT login FROM connections WHERE id = 'legacy-id'").get().login, 'legacy');
  assert.equal(db.prepare("SELECT hex(ciphertext) AS value FROM credentials WHERE ref = 'legacy-ref'").get().value, '6C6567616379');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const vault = {
    available: () => true,
    async encrypt(token) { return Buffer.from(token); },
    save(ref, ciphertext) {
      db.prepare('INSERT INTO credentials VALUES (?, ?) ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext')
        .run(ref, ciphertext);
    },
    read(ref) {
      return Buffer.from(db.prepare('SELECT ciphertext FROM credentials WHERE ref = ?').get(ref).ciphertext).toString() || undefined;
    },
    forget(ref) { db.prepare("UPDATE credentials SET ciphertext = X'' WHERE ref = ?").run(ref); },
  };

  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const merge = 'c'.repeat(40);
  const tree = 'd'.repeat(40);
  const shaOf = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
  const blob = shaOf('hello\n');
  const oldBlob = shaOf('before\n');
  const newHead = 'f'.repeat(40);
  const file = { filename: 'index.js', previous_filename: 'old.js', status: 'renamed', additions: 1, deletions: 1, sha: blob,
    patch: '@@ -1 +1 @@\n-before\n+hello' };
  const item = number => ({ id: 900 + number, node_id: `PR_${number}`, number, pull_request: {},
    repository_url: 'https://api.github.com/repos/owner/repo' });
  const page = (nodes, totalCount = nodes.length, endCursor = null) =>
    ({ nodes, totalCount, pageInfo: { endCursor, hasNextPage: !!endCursor } });
  const calls = [];
  let mode = 'healthy';
  let metadataReads = 0;
  const request = async (url, options) => {
    const path = url.pathname;
    calls.push([path, url.search, options.headers.Authorization]);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'manual');
    if (mode === 'offline') throw new Error('offline');
    if (mode === 'rate') return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
    if (mode === 'unauthorized') return new Response(null, { status: 401 });
    if (mode === 'slow') return new Promise((_resolve, reject) =>
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    if (path === '/user') {
      return Response.json(options.headers.Authorization === 'Bearer accountTwo' ? { id: 2, login: 'other' } : { id: 1, login: 'reviewer' });
    }
    if (path === '/search/issues') {
      if (url.searchParams.get('page') === '2') {
        return mode === 'discovery-error' ? new Response(null, { status: 503 }) :
          Response.json({ total_count: 2, incomplete_results: false, items: [item(2)] });
      }
      return Response.json({ total_count: 2, incomplete_results: false, items: [item(1)] },
        { headers: { link: '<https://api.github.com/search/issues?page=2>; rel="next"' } });
    }
    const prMatch = path.match(/^\/repos\/owner\/repo\/pulls\/(\d+)$/);
    if (prMatch) {
      const number = Number(prMatch[1]);
      metadataReads++;
      return Response.json({ id: number, node_id: `PR_${number}`, number, draft: false, merged: false,
        title: `Test PR ${number}`, body: null, user: { login: 'author' }, html_url: `https://github.com/owner/repo/pull/${number}`,
        state: mode === 'close' && number === 2 ? 'closed' : 'open', updated_at: '2026-01-01T00:00:00Z',
        base: { sha: base, repo: { id: 10, full_name: 'owner/repo' } },
        head: { sha: mode === 'race' && metadataReads > 1 ? newHead : head, repo: { full_name: 'fork/repo' } },
        changed_files: 1 });
    }
    if (/\/pulls\/\d+\/files$/.test(path)) {
      if (mode === 'file-error') return new Response(null, { status: 503 });
      return Response.json([mode === 'base-mismatch' ? { ...file, patch: '@@ -1 +1 @@\n-before\n+other' } :
        mode === 'truncated' ? { ...file, patch: '@@ -1 +1 @@' } : file]);
    }
    if (decodeURIComponent(path) === `/repos/owner/repo/compare/${base}...fork:${head}`) {
      return Response.json({ merge_base_commit: { sha: merge }, files: [file] });
    }
    if (path === `/repos/fork/repo/git/commits/${head}`) return Response.json({ sha: head, tree: { sha: tree } });
    if (path === `/repos/fork/repo/git/trees/${tree}`) {
      return Response.json({ truncated: false, tree: [{ path: file.filename, sha: blob, size: 6, type: 'blob', mode: '100644' }] });
    }
    if (path === `/repos/fork/repo/git/blobs/${blob}`) {
      return Response.json({ sha: blob, size: 6, encoding: 'base64', content: 'aGVsbG8K' });
    }
    const baseTree = 'e'.repeat(40);
    if (path === `/repos/owner/repo/git/commits/${merge}`) return Response.json({ sha: merge, tree: { sha: baseTree } });
    if (path === `/repos/owner/repo/git/trees/${baseTree}`) {
      return Response.json({ truncated: false, tree: [{ path: file.previous_filename, sha: oldBlob, size: 7, type: 'blob', mode: '100644' }] });
    }
    if (path === `/repos/owner/repo/git/blobs/${oldBlob}`) {
      return Response.json({ sha: oldBlob, size: 7, encoding: 'base64', content: 'YmVmb3JlCg==' });
    }
    if (/\/issues\/\d+\/comments$/.test(path)) return Response.json([{ id: 7, body: 'General', user: null }]);
    if (/\/pulls\/\d+\/reviews$/.test(path)) return Response.json([]);
    if (path === '/graphql') {
      if (mode === 'thread-error') return Response.json({ errors: [{ type: 'FORBIDDEN' }] });
      const { query, variables } = JSON.parse(options.body);
      if (query.includes('reviewThreads')) {
        return Response.json({ data: { node: { reviewThreads: page([{ id: 'thread', path: file.filename,
          line: 1, isResolved: false, isOutdated: false }]) } } });
      }
      if (query.includes('PullRequestReviewThread')) {
        return Response.json({ data: { node: { comments: variables.cursor ?
          page([{ id: 'reply', body: 'Follow-up', replyTo: { id: 'comment' } }], 2) :
          page([{ id: 'comment', body: 'Inline', replyTo: null }], 2, 'next') } } });
      }
    }
    throw new Error(`Unexpected fixture request ${url}`);
  };
  const cache = join(directory, 'cache');
  let service = workspace(db, vault, cache, request);
  await service.connect('replacement');
  await service.connect('accountTwo');
  assert.equal((await service.status()).connections.find(connection => connection.login === 'reviewer').id, 'legacy-id');
  const account = (await service.status()).connections.find(connection => connection.login === 'other').id;
  service.saveQuery('legacy-id', 'is:open review-requested:@me');
  service.saveQuery(account, 'is:closed author:@me');
  const query = (await service.status()).queries.find(query => query.connectionId === 'legacy-id');
  assert.throws(() => service.saveQuery(account, 'is:open', query.id), /not found/);
  assert.deepEqual(await service.pull('legacy-id'), { refreshed: 2, errors: [] });
  assert.ok(calls.some(([, search]) => search.includes('page=2')));
  assert.ok(calls.every(([, search]) => !search.includes('author')));
  const [first, second] = (await service.status()).pullRequests;
  const full = service.review(first.id);
  assert.equal(full.diff.data.diffBaseSha, merge);
  assert.equal(full.diff.data.baseSha, base);
  assert.equal(full.files.data.find(file => file.side === 'head').sha, head);
  assert.equal(full.files.data.find(file => file.side === 'base').sha, merge);
  assert.equal(await service.readFile(first.id, file.previous_filename, 'base', oldBlob), 'before\n');
  assert.equal(full.threads.data[0].comments[1].replyTo.id, 'comment');
  assert.equal(await service.readFile(first.id, file.filename, 'head', blob), 'hello\n');
  await assert.rejects(service.readFile(first.id, file.filename, 'head', oldBlob), /snapshot changed/);
  assert.equal(JSON.stringify((await service.status())).includes('replacement'), false);

  service.deleteQuery(query.id);
  mode = 'close';
  assert.deepEqual(await service.pull('legacy-id'), { refreshed: 2, errors: [] });
  assert.equal((await service.status()).pullRequests.find(pr => pr.id === second.id).state, 'closed');
  await assert.rejects(service.pull(account, second.id), /not found for this connection/);
  assert.deepEqual(await service.pull('legacy-id', second.id), { refreshed: 1, errors: [] });
  mode = 'thread-error';
  const partial = await service.pull('legacy-id');
  assert.equal(partial.refreshed, 1);
  assert.match(partial.errors.join(), /threads:.*incomplete/);
  assert.equal(service.review(first.id).comments.complete, true);
  assert.deepEqual(service.review(first.id).threads.data, full.threads.data);
  mode = 'file-error';
  for (let i = 0; i < 2; i++) await service.pull('legacy-id');
  assert.deepEqual(service.review(first.id).diff.data, full.diff.data);
  assert.match(service.review(first.id).diff.error, /503/);
  mode = 'race';
  metadataReads = 0;
  assert.match((await service.pull('legacy-id')).errors.join(), /changed during diff pagination/);
  assert.deepEqual(service.review(first.id).diff.data, full.diff.data);
  mode = 'rate';
  const beforeRate = calls.length;
  assert.match((await service.pull('legacy-id')).errors.join(), /Retry in 60 seconds/);
  assert.equal(calls.length, beforeRate + 1);
  mode = 'unauthorized';
  await service.pull('legacy-id');
  assert.equal((await service.status()).connections.find(value => value.id === 'legacy-id').status, 'reauth_required');

  mode = 'discovery-error';
  const discovery = await service.pull(account);
  assert.equal(discovery.refreshed, 1);
  assert.match(discovery.errors.join(), /Query.*503/);
  const other = (await service.status()).pullRequests.find(pr => pr.connectionId === account);
  assert.notEqual(other.id, first.id);

  mode = 'base-mismatch';
  const secondAccount = await service.pull(account);
  assert.match(secondAccount.errors.join(), /immutable comparison could not be matched/);
  const incomplete = (await service.status()).pullRequests.find(pr => pr.connectionId === account && pr.number === 2);
  assert.equal(service.review(incomplete.id).diff.data.diffBaseSha, null);
  assert.equal(service.review(incomplete.id).diff.complete, false);

  mode = 'truncated';
  await service.pull(account);
  assert.equal(service.review(incomplete.id).diff.data.files[0].patch, null);
  assert.match(service.review(incomplete.id).diff.data.files[0].patchError, /Incomplete/);

  mode = 'slow';
  const interrupted = service.pull(account);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(service.pullProgress(account));
  service.cancelPull(account);
  assert.match((await interrupted).errors.join(), /Pull cancelled/);
  assert.equal(service.pullProgress(account), null);
  assert.notEqual((await service.status()).connections.find(value => value.id === account).status, 'disconnected');

  const pending = service.pull(account);
  await assert.rejects(service.pull(account), /already running/);
  await new Promise(resolve => setImmediate(resolve));
  service.disconnect(account);
  await pending;
  assert.equal((await service.status()).connections.find(value => value.id === account).status, 'disconnected');
  await assert.rejects(service.pull(account), /Connect this account/);

  db.close();
  db = openStore(database);
  mode = 'offline';
  service = workspace(db, vault, cache, request);
  const beforeOffline = calls.length;
  assert.equal(service.review(first.id).metadata.data.title, 'Test PR 1');
  assert.equal(await service.readFile(first.id, file.filename, 'head', blob), 'hello\n');
  assert.equal(service.review(first.id).threads.data[0].comments.length, 2);
  assert.equal(calls.length, beforeOffline);
  assert.match((await service.pull('legacy-id')).errors.join(), /could not be reached/);
  assert.equal(await service.readFile(first.id, file.filename, 'head', blob), 'hello\n');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('Pull fixtures passed');
} finally {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
}
