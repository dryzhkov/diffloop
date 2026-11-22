import { useEffect, useState } from 'react';
import { reviewContext, type AgentConfig, type AgentPolicy, type AgentScope, type AgentState, type ReviewContext } from './api';

const contextLabels: Record<ReviewContext, string> = {
  diff: 'Diff', changed_files: 'Cached changed files', pr_description: 'PR description', review_threads: 'Review discussion',
};
const blank: AgentConfig = {
  id: '', name: '', model: '', context: ['diff'], allowDrafts: false,
  review: { kind: 'instructions', text: '' },
};

function Permissions<T extends Pick<AgentPolicy, 'context' | 'allowDrafts'>>({ value, set }: {
  value: T; set: (next: T) => void;
}) {
  return <>
    {reviewContext.map(kind => <label key={kind}>
      <input className="option" type="checkbox" checked={value.context.includes(kind)}
        onChange={e => set({ ...value, context: e.target.checked ? [...value.context, kind] : value.context.filter(k => k !== kind) })} />
      {contextLabels[kind]}
    </label>)}
    <label><input className="option" type="checkbox" checked={value.allowDrafts}
      onChange={e => set({ ...value, allowDrafts: e.target.checked })} /> Allow local drafts with run approval</label>
  </>;
}

function PolicyEditor({ title, value, save, pending }: {
  title: string; value: AgentPolicy; save: (policy: AgentPolicy) => void; pending: boolean;
}) {
  const [form, set] = useState(value);
  useEffect(() => set(value), [JSON.stringify(value)]);
  return <fieldset disabled={pending}>
    <legend>{title}</legend>
    <label><input className="option" type="checkbox" checked={form.enabled}
      onChange={e => set({ ...form, enabled: e.target.checked })} /> Enable Codex for this scope</label>
    <Permissions value={form} set={set} />
    <button onClick={() => save(form)}>Save grant</button>
  </fieldset>;
}

export function AgentsView({ pr, scope, clearScope, head, base, diffBase, onDraftsChanged }: {
  pr: string; scope: AgentScope; clearScope: () => void; head: string; base: string;
  diffBase: string | null; onDraftsChanged: () => void;
}) {
  const api = window.workspace;
  const [state, setState] = useState<AgentState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [form, edit] = useState(blank);
  const [requested, setRequested] = useState(false);
  const [selected, select] = useState('');
  useEffect(() => setRequested(false), [scope]);
  const running = state?.runs.some(run => run.status === 'running');
  useEffect(() => {
    let live = true;
    const refresh = () => api.agentState(pr).then(next => {
      if (live) setState(next);
    }, error => {
      if (live) setError(String(error));
    });
    void refresh();
    const interval = running ? window.setInterval(() => { void refresh(); onDraftsChanged(); }, 800) : undefined;
    return () => { live = false; window.clearInterval(interval); };
  }, [pr, running]);
  async function act(action: () => Promise<unknown>) {
    setError('');
    setPending(true);
    try {
      await action();
      setState(await api.agentState(pr));
    } catch (error) { setError(String(error)); }
    finally { setPending(false); }
  }
  const cfg = state?.configs.find(c => c.id === selected);
  const repo = state?.repository;
  const draftAllowed = !!(cfg?.allowDrafts && state?.connection.allowDrafts && (repo?.allowDrafts ?? true));

  return <details id="agent-review">
    <summary>Codex review</summary>
    {error && <p role="alert">{error}</p>}
    {state && <>
      {state.blocked && <p role="status">{state.blocked}</p>}
      <details>
        <summary>Context grants</summary>
        <PolicyEditor title="GitHub connection" value={state.connection} pending={pending}
          save={value => void act(() => api.agentPolicy(pr, false, value))} />
        <PolicyEditor title="Repository override" value={repo ?? state.connection} pending={pending}
          save={value => void act(() => api.agentPolicy(pr, true, value))} />
        {repo && <button disabled={pending} onClick={() => void act(() => api.agentPolicy(pr, true, null))}>Remove repository override</button>}
        <p>Local folder {state.localRoot ?? 'unmapped'}. Local file access is disabled.</p>
        <button disabled={pending} onClick={() => void act(() => api.agentMap(pr, false))}>Choose local folder</button>
        {state.localRoot && <button disabled={pending} onClick={() => void act(() => api.agentMap(pr, true))}>Remove local folder</button>}
      </details>
      <label>Configuration <select value={selected} disabled={pending} onChange={e => {
        const id = e.target.value;
        select(id);
        edit(state.configs.find(c => c.id === id) ?? blank);
        setRequested(false);
      }}>
        <option value="">New configuration</option>
        {state.configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      <details>
        <summary>Edit configuration</summary>
        <form onSubmit={e => {
          e.preventDefault();
          void act(async () => { const next = await api.agentConfig(pr, form); edit(next); select(next.id); setRequested(false); });
        }}>
          <fieldset disabled={pending}>
            <label>Name <input required maxLength={100} value={form.name} onChange={e => edit({ ...form, name: e.target.value })} /></label>
            <label>Codex model <input required maxLength={100} value={form.model} onChange={e => edit({ ...form, model: e.target.value })} /></label>
            <label>Review method <select value={form.review.kind} onChange={e =>
              edit({ ...form, review: { kind: e.target.value as AgentConfig['review']['kind'], text: '' } })}>
              <option value="instructions">Direct instructions</option><option value="skill">Registered skill</option><option value="plugin">Registered plugin</option>
            </select></label>
            <label>{form.review.kind === 'instructions' ? 'Defensive review instructions' : 'Registered name'}
              <textarea required maxLength={8000} value={form.review.text}
                onChange={e => edit({ ...form, review: { ...form.review, text: e.target.value } })} />
            </label>
            <Permissions value={form} set={edit} />
            <button type="submit">Save configuration</button>
            {form.id && <button type="button" onClick={() => void act(async () => {
              await api.agentDeleteConfig(pr, form.id); select(''); edit(blank);
            })}>Delete configuration</button>}
          </fieldset>
        </form>
      </details>
      <p>Scope {scope.kind === 'pr' ? 'entire PR' : scope.kind === 'thread' ? 'selected thread' :
        `${scope.anchor.path} · ${scope.anchor.side} ${scope.anchor.startLine}–${scope.anchor.endLine}`}
        {scope.kind !== 'pr' && <button onClick={clearScope}>Use entire PR</button>}
      </p>
      {cfg?.review.kind !== undefined && cfg.review.kind !== 'instructions' && <p>Registered extensions are disabled pending isolation verification.</p>}
      <label><input className="option" type="checkbox" disabled={!draftAllowed || !!state.blocked} checked={draftAllowed && requested}
        onChange={e => setRequested(e.target.checked)} /> Allow editable local drafts for this run</label>
      <button disabled={pending || !!state.blocked || cfg?.review.kind !== 'instructions' || running ||
        !state.connection.enabled || repo?.enabled === false}
        onClick={() => void act(async () => { await api.agentStart(pr, selected, scope, draftAllowed && requested); setRequested(false); })}>
        Start review
      </button>
      <h3>Review history</h3>
      {!state.runs.length && <p>No review runs.</p>}
      {state.runs.map(run => {
        const stale = run.head !== head || run.base !== base || (!!run.diffBase && run.diffBase !== diffBase);
        return <details key={run.id}>
          <summary>{run.config.name} · {run.status} · {new Date(run.started).toLocaleString()}</summary>
          <p>{run.runtime} · {run.model} · {run.scope.kind} · {run.head}</p>
          {run.error && <p>{run.error}</p>}
          {stale && <p>Review revision changed. Recheck findings.</p>}
          {run.status === 'running' && <button disabled={pending} onClick={() => void act(() => api.agentCancel(pr, run.id))}>Cancel review</button>}
          <details><summary>Context accessed ({run.manifest.length})</summary>
            <ul>{run.manifest.map(item => <li key={JSON.stringify([item.key, item.hash, item.via])}>{item.key} · {item.via} · {item.revision} · {item.hash}</li>)}</ul>
            {run.searches.map((search, i) => <p key={i}>Search “{search.query}” · {search.resources.join(', ') || 'no resources covered'}
              {search.truncated && ' · incomplete coverage'}</p>)}
          </details>
          {run.findings.map(f => <article key={f.id}>
            <h4>{f.title} · {f.disposition}</h4><p className="body">{f.explanation}</p><p className="body">{f.evidence}</p>
            {f.anchor && <p>{f.anchor.path} · {f.anchor.side} {f.anchor.startLine}–{f.anchor.endLine}</p>}
            {f.suggestedComment && <p className="body">{f.suggestedComment}</p>}
            {f.disposition === 'open' && run.status !== 'running' && <>
              <button disabled={pending} onClick={() => void act(() => api.agentFinding(pr, run.id, f.id, false))}>Dismiss</button>
              {f.suggestedComment && <button disabled={pending || stale} onClick={() => void act(async () => {
                await api.agentFinding(pr, run.id, f.id, true);
                onDraftsChanged();
              })}>Create editable local draft</button>}
            </>}
          </article>)}
        </details>;
      })}
    </>}
  </details>;
}
