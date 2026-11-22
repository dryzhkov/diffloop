import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'diffloop-agents-'));
let db;
try {
  await build({
    entryPoints: ['src/agents.ts', 'src/store.ts', 'src/publishing.ts'], outdir: directory,
    outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm',
  });
  const { agents } = await import(join(directory, 'agents.mjs'));
  const { openStore } = await import(join(directory, 'store.mjs'));
  const { publishing } = await import(join(directory, 'publishing.mjs'));
  const database = join(directory, 'fixture.sqlite');
  db = openStore(database);
  db.exec(`
    INSERT INTO credentials VALUES ('vault', X'00');
    INSERT INTO connections (id, account_id, login, credential_ref) VALUES ('c', 'account', 'fixture', 'vault');
    INSERT INTO credentials VALUES ('other-vault', X'00');
    INSERT INTO connections (id, account_id, login, credential_ref) VALUES ('empty', 'other-account', 'other', 'other-vault');
    INSERT INTO pull_requests VALUES ('p', 'c', 'remote', 'synthetic/project', 1, 'open');
    INSERT INTO pull_requests VALUES ('q', 'c', 'other', 'synthetic/other', 2, 'open');
  `);

  const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40);
  const revision = base + ':' + head;
  const cached = data => ({ data, complete: true, revision, error: null, cachedAt: '2026-01-01' });
  const patch = '@@ -1,2 +1,2 @@\n-old\n+new\n outside selection';
  const anchor = { path: 'main.js', side: 'head', commitSha: head, startLine: 1, endLine: 1 };
  const snapshot = {
    metadata: cached({ repositoryId: 'repo-1', title: 'Synthetic PR', body: 'ungranted PR text', baseSha: base, headSha: head }),
    diff: cached({ baseSha: base, headSha: head, diffBaseSha: merge, files: [{ path: 'main.js', patch }, { path: 'other.js', patch }] }),
    files: cached([{ path: 'main.js', side: 'head', sha: head, blob: 'd'.repeat(40) }]),
    comments: cached([{ id: 'general', body: 'unscoped thread text' }]),
    reviews: cached([]),
    threads: cached([{ id: 'thread1', comments: [{ body: 'thread one' }] }, { id: 'thread2', comments: [{ body: 'thread two' }] }]),
  };
  const review = id => id === 'p' ? snapshot : { ...snapshot, metadata: cached({ ...snapshot.metadata.data, repositoryId: 'repo-2' }) };
  const noRead = async () => assert.fail('Unexpected cache read');
  const production = agents(db, review, noRead);
  assert.match(production.agentState('p').blocked, /Live Codex review is unavailable/);
  assert.throws(() => production.agentStart('p', '', { kind: 'pr' }, false), /unavailable/);
  assert.deepEqual(production.agentState('p').runs, []);
  const unused = production.agentConfig('empty', {
    id: '', name: 'Before Pull', model: 'fixture', context: ['diff'], allowDrafts: false,
    review: { kind: 'instructions', text: 'Review correctness.' },
  }, true);
  assert.deepEqual(production.agentState('empty', true).configs, [unused]);
  assert.deepEqual(production.agentState('c', true).configs, []);
  assert.throws(() => production.agentConfig('c', unused, true), /Unknown review configuration/);
  production.agentDeleteConfig('empty', unused.id, true);
  assert.deepEqual(production.agentState('empty', true).configs, []);

  const waitForRun = async (service, id, status) => {
    for (let n = 0; n < 100; n++) {
      const run = service.agentState('p').runs.find(run => run.id === id);
      if (run?.status === status) return run;
      if (run && run.status !== 'running') assert.fail(`Expected ${status}, got ${run.status}: ${run.error}`);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`Run never reached ${status}`);
  };
  let execute;
  let failure;
  const runtime = { version: 'synthetic', async execute(args) {
    try { await execute(args); } catch (error) { failure = error; throw error; }
  } };
  let readCached = noRead;
  const service = agents(db, review, (pr, file) => readCached(pr, file), runtime);
  const global = { enabled: true, context: ['diff', 'changed_files', 'review_threads'], allowDrafts: true };
  const config = service.agentConfig('p', { id: '', name: 'Defensive', model: 'fixture', review: {
    kind: 'instructions', text: 'Verify changed code for correctness.',
  }, context: ['diff', 'changed_files', 'pr_description', 'review_threads'], allowDrafts: true });
  assert.throws(() => service.agentStart('p', config.id, { kind: 'pr' }, false), /access is disabled/);
  service.agentPolicy('p', false, global);
  service.agentPolicy('p', true, { ...global, context: ['diff'], allowDrafts: false });
  assert.throws(() => service.agentStart('p', config.id, { kind: 'pr' }, true), /outside the grant/);
  assert.throws(() => service.agentStart('p', config.id, { kind: 'selection', anchor: { ...anchor, commitSha: merge } }, false), /Invalid review anchor/);
  const extension = service.agentConfig('p', { ...config, id: '', review: { kind: 'skill', text: 'fixture-skill' } });
  assert.throws(() => service.agentStart('p', extension.id, { kind: 'pr' }, false), /Registered extensions/);
  service.agentMap('p', '/synthetic/checkout');
  assert.equal(service.agentState('p').localRoot, '/synthetic/checkout');

  const finding = { title: 'Review return value', evidence: 'Fixture line 1', explanation: 'Check the changed return value.', suggestedComment: 'Please check the return value.', anchor };
  let selectionContent;
  execute = async ({ tools }) => {
    assert.deepEqual(Object.keys(tools).sort(), ['addFinding', 'list', 'read', 'search']);
    assert.deepEqual(tools.list().map(r => r.key), ['selection']);
    await assert.rejects(tools.read('diff:other.js'), /outside the grant/);
    await assert.rejects(tools.read('description'), /outside the grant/);
    assert.throws(() => tools.addFinding(finding), /Read the granted anchor/);
    selectionContent = await tools.read('selection');
    assert.match(selectionContent, /new/);
    assert.doesNotMatch(selectionContent, /outside selection/);
    assert.deepEqual(await tools.search('outside selection'), []);
    assert.throws(() => tools.addFinding({ ...finding, anchor: { ...anchor, endLine: 2 } }), /outside the selection/);
    tools.addFinding(finding);
  };
  const selection = service.agentStart('p', config.id, { kind: 'selection', anchor }, false);
  const selectionRun = await waitForRun(service, selection, 'completed').catch(error => { throw failure ?? error; });
  assert.equal(selectionRun.manifest[0].hash, createHash('sha256').update(selectionContent).digest('hex'));
  assert.deepEqual(selectionRun.searches[0], { query: 'outside selection', resources: ['selection'], truncated: false });
  assert.equal(db.prepare('SELECT count(*) AS n FROM drafts').get().n, 0);
  assert.throws(() => service.agentFinding('q', selection, selectionRun.findings[0].id, true), /Unknown review run/);

  let remoteCalls = 0;
  const drafts = publishing(db, review, async () => { remoteCalls++; assert.fail('Publishing must be unreachable'); });
  snapshot.metadata.data.headSha = 'e'.repeat(40);
  assert.throws(() => service.agentFinding('p', selection, selectionRun.findings[0].id, true), /revision changed/);
  snapshot.metadata.data.headSha = head;
  service.agentFinding('p', selection, selectionRun.findings[0].id, true);
  const [draft] = drafts.drafts('p');
  assert.equal(draft.agentRunId, selection);
  assert.equal(draft.findingId, selectionRun.findings[0].id);
  assert.equal(draft.target.kind, 'inline');
  assert.equal(draft.included, false);
  drafts.editDraft(draft.id, 'User edited this comment.', false, false);
  assert.equal(drafts.drafts('p')[0].body, 'User edited this comment.');

  service.agentPolicy('p', true, { ...global, context: ['review_threads'] });
  execute = async ({ tools }) => {
    assert.deepEqual(Object.keys(tools).sort(), ['addFinding', 'createDraft', 'list', 'read', 'search']);
    assert.deepEqual(tools.list().map(r => r.key), ['thread']);
    assert.match(await tools.read('thread'), /thread one/);
    await assert.rejects(tools.read('thread:thread2'), /outside the grant/);
    const { anchor: _, ...plainFinding } = finding;
    const id = tools.addFinding(plainFinding);
    tools.createDraft(id);
    assert.throws(() => tools.createDraft(id), /already closed/);
    assert.throws(() => tools.createDraft(draft.id), /Unknown finding/);
  };
  const thread = service.agentStart('p', config.id, { kind: 'thread', thread: 'thread1' }, true);
  await waitForRun(service, thread, 'completed').catch(error => { throw failure ?? error; });
  assert.equal(drafts.drafts('p').length, 2);
  assert.equal(drafts.drafts('p')[1].included, false);
  assert.equal(remoteCalls, 0);

  service.agentPolicy('p', true, null);
  let returned;
  let entered;
  let completeRead;
  const waiting = new Promise(resolve => { entered = resolve; });
  readCached = () => new Promise(resolve => { completeRead = resolve; entered(); });
  execute = async ({ tools, signal }) => {
    assert.equal(tools.list().some(item => item.key === 'description'), false);
    try { await tools.read('file:head:main.js'); } catch (error) { returned = error; }
    assert.equal(signal.aborted, true);
    assert.throws(() => tools.list());
  };
  const cancelled = service.agentStart('p', config.id, { kind: 'pr' }, false);
  await waiting;
  service.agentPolicy('p', false, { ...global, context: ['diff'] });
  completeRead('fixture content returned after revocation');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(returned);
  assert.deepEqual((await waitForRun(service, cancelled, 'cancelled')).manifest, []);

  execute = async ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  const userCancel = service.agentStart('p', config.id, { kind: 'pr' }, false);
  service.agentCancel('q', userCancel);
  assert.equal(service.agentState('p').runs[0].status, 'running');
  service.agentCancel('p', userCancel);
  await waitForRun(service, userCancel, 'cancelled');

  const disconnected = service.agentStart('p', config.id, { kind: 'pr' }, false);
  service.cancelConnection('c');
  db.exec("UPDATE connections SET status='disconnected' WHERE id='c'");
  await waitForRun(service, disconnected, 'cancelled');
  assert.throws(() => service.agentStart('p', config.id, { kind: 'pr' }, false), /access is disabled/);
  db.exec("UPDATE connections SET status='connected' WHERE id='c'");
  service.agentConfig('p', { ...config, name: 'Updated' });
  db.close();
  db = openStore(database);
  const reopened = agents(db, review, noRead).agentState('p');
  assert.equal(reopened.configs[0].name, 'Updated');
  assert.equal(reopened.repository, null);
  assert.equal(reopened.localRoot, '/synthetic/checkout');
  assert.equal(reopened.runs.find(run => run.id === selection).config.name, 'Defensive');
  assert.equal(reopened.runs.find(run => run.id === selection).findings[0].disposition, 'converted_to_draft');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('PASS grants, scoped context, cancellation, run history, findings, and editable local-only drafts');
} finally {
  db?.close();
  await rm(directory, { recursive: true, force: true });
}
