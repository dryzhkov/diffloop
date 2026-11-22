import { useEffect, useState } from 'react';
import type { Draft, DraftTarget } from './api';

function label(t: DraftTarget) {
  switch (t.kind) {
    case 'inline': {
      const { path, side, startLine, endLine } = t.anchor;
      const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
      return `${path} · ${side} ${lines}`;
    }
    case 'reply': return 'Reply to comment ' + t.parent;
    case 'review': return {APPROVE:'Approve', REQUEST_CHANGES:'Request changes', COMMENT:'Submit review'}[t.event];
    case 'thread': return (t.resolve ? 'Resolve' : 'Reopen') + ' thread ' + t.thread;
    case 'pr': return 'General PR comment';
  }
}

function DraftRow({ pr, d, head, run, onPublished }: {onPublished:()=>Promise<void>; pr:string; d: Draft; head: string; run: (fn: () => Promise<void>) => Promise<void>}) {
  const [body, setBody] = useState(d.body);
  const api = window.workspace;
  const ready = d.status === 'local' || d.status === 'failed';
  const separate = d.target.kind === 'thread' || d.target.kind === 'review';
  return <article>
    <strong>{label(d.target)}</strong> · {d.status}{d.agentRunId && ' · Agent finding'}
    {d.head !== head && d.status !== 'pushed' && <p>Revision changed. Recheck against {d.head}.</p>}
    {d.target.kind !== 'thread' && <textarea aria-label="Draft body" value={body} readOnly={d.status === 'pushed'}
      onChange={e => setBody(e.target.value)} />}
    <div className="toolbar">
      {d.status !== 'pushed' && <button disabled={body === d.body} onClick={() => run(() => api.editDraft(d.id,body,d.included,false))}>Save edits</button>}
      {ready && !separate && <label><input type="checkbox" className="option" checked={d.included}
        onChange={e => run(() => api.editDraft(d.id,body,e.target.checked,false))}/> Include in Push</label>}
      {ready && separate && <button disabled={body !== d.body} onClick={() => run(async () => {await api.pushDrafts(pr,[d.id]); await onPublished();})}>{label(d.target)} on GitHub</button>}
      {ready && (d.target.kind === 'inline' || d.target.kind === 'reply') && <button onClick={() => run(() => api.editDraft(d.id,body,d.included,true))}>Move to general comment</button>}
      {ready && <button onClick={() => run(() => api.discardDraft(d.id))}>Discard draft</button>}
      {d.url && <button onClick={() => run(() => api.openDraftUrl(d.id))}>View on GitHub</button>}
      {d.status === 'uncertain' && <>
        <button onClick={() => run(async () => {await api.checkDraft(d.id); await onPublished();})}>Check publication</button>
        <button onClick={() => run(() => api.resolveDraft(d.id))}>I verified this was not published</button>
      </>}
    </div>
    {d.detail && <p>{d.detail}</p>}
  </article>;
}


export function DraftsView({pr,head,target,setTarget,onPublished,agentDraftRevision}: {agentDraftRevision?: number; onPublished:()=>Promise<void>; pr:string; head:string; target:DraftTarget; setTarget:(t:DraftTarget)=>void}) {
  const [items,setItems] = useState<Draft[]>([]);
  const [body,setBody] = useState('');
  const [error,setError] = useState('');
  const [pending,setPending] = useState(0);
  const api = window.workspace;
  async function reload() {setItems(await api.drafts(pr));}
  useEffect(() => {void reload().catch(e => setError(String(e)));},[pr,agentDraftRevision]);
  async function run(fn:()=>Promise<void>) {
    setPending(n=>n+1); setError('');
    try {await fn(); await reload();} catch(e) {setError(String(e));} finally {setPending(n=>n-1);}
  }
  const selected = items.filter(d => d.included && (d.status==='local'||d.status==='failed') && !['thread','review'].includes(d.target.kind));
  return <section id="draft-panel"><h3>Local drafts</h3>
    <label>Draft type <select value={target.kind==='review'?target.event:target.kind}
      onChange={e=>setTarget(e.target.value==='pr'?{kind:'pr'}:{kind:'review',event:e.target.value as 'COMMENT'|'APPROVE'|'REQUEST_CHANGES'})}>
      <option value="pr">General PR comment</option>
      {['inline','reply','thread'].includes(target.kind) && <option value={target.kind}>{label(target)}</option>}
      <option value="COMMENT">Review body</option><option value="APPROVE">Approval</option><option value="REQUEST_CHANGES">Request changes</option>
    </select></label>
    {target.kind !== 'thread' && <textarea aria-label="New draft text" value={body} onChange={e=>setBody(e.target.value)} />}
    <button disabled={!!pending} onClick={()=>run(async()=>{await api.addDraft(pr,target,head,body);setBody('');setTarget({kind:'pr'});})}>Save local draft</button>
    {items.map(d=><DraftRow onPublished={onPublished} pr={pr} key={d.id} d={d} head={head} run={run}/>)}
    <button disabled={!!pending || !selected.length} onClick={()=>run(()=>api.pushDrafts(pr,selected.map(d=>d.id)))}>Push selected comments ({selected.length})</button>
    {pending>0 && <p role="status">Working…</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
