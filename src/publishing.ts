import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Draft, DraftTarget, Review } from './api';
import { GitHub, GitHubError } from './github';
import { isRepository, isSha, message } from './revisions';
import { parseLines } from './diff-lines';

type Entry = Draft & { pr: string };
interface Remote { id: number; html_url: string; body: string }
interface Attempt { id: string; payload: string; baseline: string }
const action = (target: DraftTarget) => target.kind === 'review' || target.kind === 'thread';
const marker = (id: string) => `<!-- diffloop:${id} -->`;

export function publishing(db: DatabaseSync, review: (pr: string) => Review,
  client: (connection: string, signal: AbortSignal) => Promise<GitHub>) {
  const operations = new Map<string, AbortController>();
  const tx = (fn: () => void) => {
    db.exec('BEGIN IMMEDIATE');
    try { fn(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  tx(() => {
    db.exec("UPDATE drafts SET status='local' WHERE status='pushing' AND id IN (SELECT draft FROM push_attempts WHERE status='queued')");
    db.exec("UPDATE push_attempts SET status='interrupted', finished=CURRENT_TIMESTAMP WHERE status='queued'");
    db.exec("UPDATE drafts SET status='uncertain', detail='Interrupted during submission. Check GitHub.' WHERE status='pushing'");
    db.exec("UPDATE push_attempts SET status='uncertain' WHERE status='sending'");
  });
  function entries(pr: string): Entry[] {
    return db.prepare('SELECT * FROM drafts WHERE pr=? ORDER BY rowid').all(pr).map(row =>
      ({ ...row, included: !!row.included, target: JSON.parse(String(row.target)) }) as Entry);
  }
  function context(pr: string) {
    const row = db.prepare('SELECT repository, number, connection_id, remote_id FROM pull_requests WHERE id=?').get(pr);
    if (!row || !isRepository(row.repository)) throw new Error('Unknown PR');
    const root = '/repos/' + row.repository;
    return { pulls: root + '/pulls/' + row.number, issues: root + '/issues/' + row.number,
      web: 'https://github.com/' + row.repository + '/pull/' + row.number, remote: row.remote_id,
      connection: String(row.connection_id) };
  }
  function validate(target: DraftTarget, snapshot: Review, head: string) {
    if (!isSha(head) || head !== snapshot.metadata.data?.headSha) throw new Error('Refresh the displayed review before saving');
    if (!target || typeof target !== 'object') throw new Error('Invalid draft target');
    if (target.kind === 'pr' || (target.kind === 'review' && ['COMMENT','APPROVE','REQUEST_CHANGES'].includes(target.event))) return;
    if (target.kind === 'thread' && typeof target.resolve === 'boolean' &&
      snapshot.threads.data?.some(t => t.id === target.thread)) return;
    if (target.kind === 'reply' && /^\d+$/.test(target.parent) && snapshot.threads.data?.some(t =>
      t.comments.some(c => !c.replyTo && c.url?.endsWith('#discussion_r' + target.parent)))) return;
    if (target.kind === 'inline') {
      const diff = snapshot.diff.data, a = target.anchor;
      const file = diff?.files.find(f => (a.side === 'base' ? f.previousPath ?? f.path : f.path) === a.path);
      if (diff?.headSha === head && diff.diffBaseSha && file?.patch && ['head','base'].includes(a.side) &&
        a.commitSha === (a.side === 'base' ? diff.diffBaseSha : head) && a.startLine <= a.endLine) {
        const rows = parseLines(file.patch);
        const first = rows.find(r => r[a.side] === a.startLine);
        if (first && rows.some(r => r.hunk === first.hunk && r[a.side] === a.endLine)) return;
      }
    }
    throw new Error('Target unavailable in this cached review');
  }
  function finish(d: Entry, attempt: Attempt, status: Draft['status'], detail: string, remote?: { id: string; url: string }) {
    tx(() => {
      const edited = status === 'pushed' && db.prepare('SELECT body FROM drafts WHERE id=?').get(d.id)?.body !== d.body;
      const result = [detail, edited ? 'Newer local text was saved. Copy it to GitHub to update the published comment.' : ''].filter(Boolean).join(' ');
      db.prepare('UPDATE drafts SET status=?,detail=?,url=? WHERE id=?').run(status, result, remote?.url ?? context(d.pr).web, d.id);
      db.prepare('UPDATE push_attempts SET status=?,remote_id=?,finished=CURRENT_TIMESTAMP WHERE id=?')
        .run(status, remote?.id ?? null, attempt.id);
      if (status === 'pushed' && d.target.kind === 'review') {
        for (const key of JSON.parse(attempt.baseline)) db.prepare('UPDATE attention_events SET acknowledged=1 WHERE pr_id=? AND event_key=?').run(d.pr, key);
      }
    });
  }
  async function submit(d: Entry, attempt: Attempt, github: GitHub) {
    const c = context(d.pr), target = d.target;
    let sending = false;
    try {
      if (!d.body.trim() && target.kind !== 'thread' && !(target.kind === 'review' && target.event === 'APPROVE')) throw new Error('Enter a comment before publishing');
      const { data: live } = await github.get<{node_id: string; head: {sha: string}; base: {sha: string}}>(c.pulls);
      if (live.node_id !== c.remote || !isSha(live.head.sha)) throw new Error('PR identity or revision unavailable');
      const advanced = live.head.sha !== d.head;
      if (advanced && target.kind === 'review') {
        const notice = `Remote head is now ${live.head.sha}. Submit again to review the previously pulled commit ${d.head}.`;
        if (d.detail !== notice) throw new Error(notice);
      }
      let path = c.issues + '/comments';
      const payload: Record<string, unknown> = { body: d.body + '\n\n' + marker(attempt.id) };
      if (target.kind === 'inline') {
        if (advanced) throw new Error('Head changed. Recheck the anchor or move to a general comment.');
        const snapshot = review(d.pr);
        validate(target, snapshot, d.head);
        if (live.base.sha !== snapshot.diff.data?.baseSha) throw new Error('Base changed. Pull and recheck the anchor.');
        const a = target.anchor;
        const file = snapshot.diff.data.files.find(f => (a.side === 'base' ? f.previousPath ?? f.path : f.path) === a.path)!;
        const side = a.side === 'base' ? 'LEFT' : 'RIGHT';
        Object.assign(payload, { commit_id: d.head, path: file.path, line: a.endLine, side });
        if (a.startLine !== a.endLine) Object.assign(payload, { start_line: a.startLine, start_side: side });
        path = c.pulls + '/comments';
      } else if (target.kind === 'reply') path = c.pulls + '/comments/' + target.parent + '/replies';
      else if (target.kind === 'review') {
        path = c.pulls + '/reviews';
        Object.assign(payload, { event: target.event, commit_id: d.head });
      }
      db.prepare("UPDATE push_attempts SET status='sending' WHERE id=?").run(attempt.id);
      sending = true;
      let remote;
      if (target.kind === 'thread') {
        const method = target.resolve ? 'resolveReviewThread' : 'unresolveReviewThread';
        const { data } = await github.send<{data?: Record<string,{thread:{id:string;isResolved:boolean}}>}>('/graphql', {
          query: `mutation($id:ID!){${method}(input:{threadId:$id}){thread{id isResolved}}}`, variables: {id:target.thread},
        });
        const thread = data.data?.[method]?.thread;
        if (thread?.id !== target.thread || thread.isResolved !== target.resolve) throw new Error('Thread result unconfirmed');
        remote = {id: thread.id, url:c.web};
      } else {
        const { data } = await github.send<Remote>(path, payload);
        if (!Number.isSafeInteger(data.id) || !data.html_url?.startsWith('https://github.com/')) throw new Error('Publication unconfirmed');
        remote = {id:String(data.id), url:data.html_url};
      }
      finish(d, attempt, 'pushed', target.kind === 'review' ? `Reviewed ${d.head}.${advanced ? ' Remote head has advanced to ' + live.head.sha : ''}` : '', remote);
    } catch (error) {
      const rejected = error instanceof GitHubError && error.status >= 400 && error.status < 500 && error.status !== 408;
      finish(d, attempt, sending && !rejected ? 'uncertain' : 'failed', message(error));
    }
  }
  return {
    cancel(connection: string) { operations.get(connection)?.abort(); },
    drafts: entries,
    draftUrl(id: string) {
      const row = db.prepare('SELECT pr,url FROM drafts WHERE id=?').get(id);
      if (!row) throw new Error('Unknown draft');
      return String(row.url || context(String(row.pr)).web);
    },
    resolveDraft(id: string) {
      if (!db.prepare("UPDATE drafts SET status='failed', detail='Manually verified as unpublished' WHERE id=? AND status='uncertain'").run(id).changes) throw new Error('Draft is not uncertain');
    },
    addDraft(pr: string, target: DraftTarget, head: string, body: string) {
      validate(target, review(pr), head);
      db.prepare('INSERT INTO drafts(id,pr,target,head,body) VALUES(?,?,?,?,?)').run(randomUUID(),pr,JSON.stringify(target),head,body);
    },
    editDraft(id: string, body: string, included: boolean, general: boolean) {
      const row = db.prepare('SELECT status,target FROM drafts WHERE id=?').get(id);
      if (!row || row.status === 'pushed' || (general && (!['local','failed'].includes(String(row.status)) ||
        action(JSON.parse(String(row.target)))))) throw new Error('Draft cannot be changed');
      db.prepare('UPDATE drafts SET body=?,included=?,target=? WHERE id=?')
        .run(body,Number(included),general ? '{"kind":"pr"}' : row.target,id);
    },
    discardDraft(id: string) {
      if (!db.prepare("DELETE FROM drafts WHERE id=? AND status IN ('local','failed')").run(id).changes) throw new Error('Draft cannot be discarded');
    },
    async pushDrafts(pr: string, ids: string[]) {
      const c = context(pr);
      if (operations.has(c.connection)) throw new Error('Another publication is running');
      const selected = entries(pr).filter(d => ids.includes(d.id) && (action(d.target) || d.included) && ['local','failed'].includes(d.status));
      if (!selected.length || selected.length !== ids.length || (selected.length > 1 && selected.some(d => action(d.target)))) {
        throw new Error('Select local comments or one separate action');
      }
      const controller = new AbortController();
      operations.set(c.connection,controller);
      try {
        const baseline = JSON.stringify(db.prepare('SELECT event_key FROM attention_events WHERE pr_id=? AND active=1 AND acknowledged=0').all(pr).map(r => r.event_key));
        const attempts = selected.map(d => ({ id:randomUUID(), payload:JSON.stringify(d), baseline: d.target.kind === 'review' ? baseline : '[]' }));
        tx(() => selected.forEach((d,i) => {
          const a = attempts[i];
          db.prepare("INSERT INTO push_attempts(id,draft,payload,hash,baseline,status) VALUES(?,?,?,?,?,'queued')")
            .run(a.id,d.id,a.payload,createHash('sha256').update(a.payload).digest('hex'),a.baseline);
          db.prepare("UPDATE drafts SET status='pushing' WHERE id=?").run(d.id);
        }));
        let github;
        try { github = await client(c.connection,controller.signal); }
        catch (error) { selected.forEach((d,i) => finish(d,attempts[i],'failed',message(error))); return; }
        for (const [i,d] of selected.entries()) await submit(d,attempts[i],github);
      } finally { operations.delete(c.connection); }
    },
    async checkDraft(id: string) {
      const row = db.prepare("SELECT pr FROM drafts WHERE id=? AND status='uncertain'").get(id);
      if (!row) throw new Error('No uncertain submission');
      const pr = String(row.pr), d = entries(pr).find(d => d.id === id)!;
      const c = context(pr);
      if (operations.has(c.connection)) throw new Error('Another publication is running');
      const controller = new AbortController();
      operations.set(c.connection, controller);
      try {
        const github = await client(c.connection, controller.signal);
        const a = db.prepare('SELECT id,payload,baseline FROM push_attempts WHERE draft=? ORDER BY rowid DESC LIMIT 1').get(id) as unknown as Attempt;
        const frozen: Entry = JSON.parse(a.payload);
        const target = frozen.target;
        if (target.kind === 'thread') {
          const {data} = await github.get<{data?:{node?:{isResolved:boolean}}}>('/graphql',{
            query:'query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved}}}',variables:{id:target.thread}});
          if (data.data?.node?.isResolved === target.resolve) return finish(frozen,a,'pushed','Thread state confirmed',{id:target.thread,url:c.web});
        } else {
          const path = target.kind === 'pr' ? c.issues+'/comments' : c.pulls+(target.kind === 'review' ? '/reviews' : '/comments');
          const login = db.prepare('SELECT login FROM connections WHERE id=?').get(c.connection)?.login;
          for await (const remote of github.pages<Remote & {user:{login:string}}>(path+'?per_page=100', data => data as Array<Remote & {user:{login:string}}>)) {
            if (remote.user?.login.toLowerCase() === String(login).toLowerCase() && remote.body?.includes(marker(a.id))) {
              return finish(frozen,a,'pushed','Publication confirmed',{id:String(remote.id),url:remote.html_url});
            }
          }
        }
        throw new Error('Outcome still uncertain. Inspect the PR on GitHub before resolving.');
      } finally { operations.delete(c.connection); }
    },
  };
}
