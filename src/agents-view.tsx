import { Badge, Button, Card, Callout, Checkbox, Code, Heading, Progress, Select, Text, TextArea, TextField } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { reviewContext, type AgentConfig, type AgentPolicy, type AgentRun, type AgentScope, type AgentState, type ReviewContext } from './api';

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

const runStatus = {
  running: { label: 'Running', color: 'iris' },
  completed: { label: 'Completed', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  cancelled: { label: 'Cancelled', color: 'gray' },
} as const;

function scopeLabel(scope: AgentScope) {
  if (scope.kind === 'pr') return 'Entire pull request';
  if (scope.kind === 'thread') return 'Selected thread';
  const { path, side, startLine, endLine } = scope.anchor;
  return `${path} · ${side} ${startLine === endLine ? startLine : `${startLine}–${endLine}`}`;
}

function RunStatus({ status }: { status: AgentRun['status'] }) {
  return <Badge color={runStatus[status].color}>{runStatus[status].label}</Badge>;
}

function ActiveReview({ run, pending, onCancel }: { run: AgentRun; pending: boolean; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(run.started)) / 1000));
  const elapsedLabel = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  return <Card className="review-active">
    <div className="stack">
      <div className="row-between">
        <div>
          <Heading as="h3" size="3">Review in progress</Heading>
          <Text size="2" color="gray">{run.config.name} · {run.model}</Text>
        </div>
        <Button variant="soft" onClick={onCancel} disabled={pending}>Cancel review</Button>
      </div>
      <Progress aria-label="Codex review in progress" />
      <div className="review-run-meta">
        <Text size="2" color="gray">{elapsedLabel} elapsed</Text>
        <Text size="2" color="gray">{run.findings.length} {run.findings.length === 1 ? 'finding' : 'findings'} so far</Text>
      </div>
    </div>
  </Card>;
}

export function AgentsView({ pr, scope, clearScope, head, base, diffBase, onDraftsChanged }: {
  pr: string; scope: AgentScope; clearScope: () => void; head: string; base: string;
  diffBase: string | null; onDraftsChanged: () => void;
}) {
  const api = window.workspace;
  const [state, setState] = useState<AgentState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [selected, select] = useState('');
  const [runId, selectRun] = useState('');
  const [starting, setStarting] = useState(false);
  useEffect(() => setRequested(false), [scope]);
  const activeRun = state?.runs.find(run => run.status === 'running');
  const running = !!activeRun;
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

  const result = state?.runs.find(run => run.id === runId) ?? state?.runs[0];
  const stale = !!result && (result.head !== head || result.base !== base || (!!result.diffBase && result.diffBase !== diffBase));
  const canStart = !!state && !pending && !state.blocked && cfg?.review.kind === 'instructions' &&
    !running && state.connection.enabled && repo?.enabled !== false;

  async function start() {
    setStarting(true);
    try {
      await act(async () => {
        selectRun(await api.agentStart(pr, selected, scope, draftAllowed && requested));
        setRequested(false);
      });
    } finally {
      setStarting(false);
    }
  }

  return <section className="stack agent-review">
    {error && <Callout.Root color="red"><Callout.Text role="alert">{error}</Callout.Text></Callout.Root>}
    {!state && !error && <Text color="gray" role="status">Loading agent reviews…</Text>}
    {state && <>
      {state.blocked && <Callout.Root color="amber"><Callout.Text>{state.blocked}</Callout.Text></Callout.Root>}
      <Card>
        <div className="stack">
          <Heading as="h3" size="4">New review</Heading>
          <div className="review-setup-fields">
            <label className="review-field">
              <Text size="2" weight="medium">Agent</Text>
              <Select.Root value={selected || undefined} disabled={pending} onValueChange={id => {
                select(id);
                setRequested(false);
              }}>
                <Select.Trigger aria-label="Agent configuration" placeholder="Select an agent" />
                <Select.Content>
                  {state.configs.map(config => <Select.Item key={config.id} value={config.id}>{config.name}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            </label>
            <div className="review-field">
              <Text size="2" weight="medium">Scope</Text>
              <div className="review-run-meta">
                <Text size="2">{scopeLabel(scope)}</Text>
                {scope.kind !== 'pr' && <Button size="1" variant="ghost" onClick={clearScope}>Use entire PR</Button>}
              </div>
            </div>
          </div>
          <div className="row-between">
            <Text as="label" size="2" className="review-checkbox">
              <Checkbox disabled={pending || !draftAllowed || !!state.blocked} checked={draftAllowed && requested}
                onCheckedChange={checked => setRequested(checked === true)} />
              Allow editable local drafts for this run
            </Text>
            <Button disabled={!canStart} onClick={() => void start()}>{starting ? 'Starting…' : 'Start review'}</Button>
          </div>
          {!state.configs.length && <Text size="2" color="gray">Add an agent in Settings to start a review.</Text>}
          {!state.connection.enabled && <Text size="2" color="gray">Enable Codex for this GitHub account in Settings.</Text>}
          {cfg && cfg.review.kind !== 'instructions' && <Text size="2" color="gray">This agent uses a registered extension. Choose an agent with direct instructions.</Text>}
          <details className="review-disclosure">
            <summary>Repository permissions</summary>
            <PolicyEditor title="Repository override" value={repo ?? state.connection} pending={pending}
              save={value => void act(() => api.agentPolicy(pr, true, value))} />
            <div className="toolbar">
              {repo && <Button size="1" variant="soft" disabled={pending} onClick={() => void act(() => api.agentPolicy(pr, true, null))}>Remove override</Button>}
              <Button size="1" variant="soft" disabled={pending} onClick={() => void act(() => api.agentMap(pr, false))}>Choose local folder</Button>
              {state.localRoot && <Button size="1" variant="soft" disabled={pending} onClick={() => void act(() => api.agentMap(pr, true))}>Remove local folder</Button>}
            </div>
            <Text size="2" color="gray">Local folder {state.localRoot ?? 'unmapped'}. Local file access is disabled.</Text>
          </details>
        </div>
      </Card>

      {activeRun ? <ActiveReview key={activeRun.id} run={activeRun} pending={pending}
        onCancel={() => void act(() => api.agentCancel(pr, activeRun.id))} /> :
        starting && <Card><Progress aria-label="Starting Codex review" /></Card>}

      <div className="review-output">
        <section aria-label="Review runs" className="stack">
          <Heading as="h3" size="4">Runs</Heading>
          {!state.runs.length && <Card><Text size="2" color="gray">No reviews started for this PR.</Text></Card>}
          <div className="review-run-list">
            {state.runs.map(run => <button key={run.id} type="button" className="review-run-row"
              aria-pressed={result?.id === run.id} onClick={() => selectRun(run.id)}>
              <span className="row-between"><Text weight="medium">{run.config.name}</Text><RunStatus status={run.status} /></span>
              <Text size="2" color="gray">{new Date(run.started).toLocaleString()}</Text>
              <Text size="2" color="gray">{run.findings.length} {run.findings.length === 1 ? 'finding' : 'findings'}</Text>
            </button>)}
          </div>
        </section>
        <section aria-label="Review results" className="stack">
          <Heading as="h3" size="4">Results</Heading>
          {!result ? <Card><Text size="2" color="gray">Findings will appear here after you start a review.</Text></Card> : <>
            <Card>
              <div className="stack">
                <div className="row-between">
                  <Heading as="h4" size="3">{result.config.name}</Heading>
                  <RunStatus status={result.status} />
                </div>
                <Text size="2" color="gray">{result.model} · {scopeLabel(result.scope)}</Text>
                {result.error && <Callout.Root color="red"><Callout.Text>{result.error}</Callout.Text></Callout.Root>}
                {stale && <Callout.Root color="amber"><Callout.Text>The PR revision has changed. Recheck these findings before using them.</Callout.Text></Callout.Root>}
                <details className="review-disclosure">
                  <summary>Run details · {result.manifest.length} context reads</summary>
                  <p><Text size="2">{result.runtime} · Commit <Code>{result.head}</Code></Text></p>
                  <ul>{result.manifest.map(item => <li key={JSON.stringify([item.key, item.hash, item.via])}>
                    <Text size="2">{item.key} · {item.via} · {item.revision} · {item.hash}</Text>
                  </li>)}</ul>
                  {result.searches.map((search, index) => <p key={index}>Search “{search.query}” · {search.resources.join(', ') || 'no resources covered'}
                    {search.truncated && ' · incomplete coverage'}</p>)}
                </details>
              </div>
            </Card>
            {!result.findings.length && <Text size="2" color="gray">
              {result.status === 'running' ? 'Waiting for findings…' : result.status === 'completed' ? 'No findings reported.' : 'This run produced no findings.'}
            </Text>}
            {result.findings.map(finding => <Card key={finding.id}>
              <article className="stack review-finding">
                <div className="row-between">
                  <Heading as="h4" size="3">{finding.title}</Heading>
                  <Badge color={finding.disposition === 'converted_to_draft' ? 'green' : 'gray'}>
                    {finding.disposition === 'converted_to_draft' ? 'Draft created' : finding.disposition === 'dismissed' ? 'Dismissed' : 'Open'}
                  </Badge>
                </div>
                {finding.anchor && <Code>{scopeLabel({ kind: 'selection', anchor: finding.anchor })}</Code>}
                <Text as="p" size="2" className="body">{finding.explanation}</Text>
                <div className="review-field"><Text size="2" weight="medium">Evidence</Text><Text as="p" size="2" className="body">{finding.evidence}</Text></div>
                {finding.suggestedComment && <div className="review-field">
                  <Text size="2" weight="medium">Suggested comment</Text><Text as="p" size="2" className="body">{finding.suggestedComment}</Text>
                </div>}
                {finding.disposition === 'open' && result.status !== 'running' && <div className="toolbar">
                  {finding.suggestedComment && <Button size="2" variant="soft" disabled={pending || stale} onClick={() => void act(async () => {
                    await api.agentFinding(pr, result.id, finding.id, true);
                    onDraftsChanged();
                  })}>Create local draft</Button>}
                  <Button size="2" variant="ghost" disabled={pending} onClick={() => void act(() => api.agentFinding(pr, result.id, finding.id, false))}>Dismiss</Button>
                </div>}
              </article>
            </Card>)}
          </>}
        </section>
      </div>
    </>}
  </section>;
}

export function AgentDirectory({ connection, settings, onEdit, editing }: {
  connection: string; settings: boolean; onEdit: (id: string) => void; editing: string;
}) {
  const api = window.workspace;
  const [state, setState] = useState<AgentState>();
  const [form, setForm] = useState(blank);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    api.agentState(connection, true).then(value => {
      if (current) setState(value);
    }, failure => {
      if (current) setError(String(failure));
    });
    return () => { current = false; };
  }, [connection]);
  useEffect(() => {
    setForm(state?.configs.find(config => config.id === editing) ?? blank);
  }, [editing, state]);
  async function save(action: () => Promise<unknown>) {
    setPending(true);
    setError('');
    try {
      await action();
      setState(await api.agentState(connection, true));
    } catch (failure) {
      setError(String(failure));
    } finally {
      setPending(false);
    }
  }
  return <div className="stack">
    {error && <Callout.Root color="red"><Callout.Text role="alert">{error}</Callout.Text></Callout.Root>}
    {state?.blocked && <Callout.Root color="amber"><Callout.Text>{state.blocked}</Callout.Text></Callout.Root>}
    {state && <>
      {settings && <Card>
        <PolicyEditor title="Connection permissions" value={state.connection} pending={pending}
          save={value => void save(() => api.agentPolicy(connection, false, value, true))} />
      </Card>}
      {!state.configs.length && !settings && <Text color="gray">No agents configured for this account.</Text>}
      {state.configs.map(config => <Card key={config.id}>
        <div className="row-between">
          <div><Heading as="h3" size="3">{config.name}</Heading>
            <Text color="gray" size="2">{config.model}</Text></div>
          <Badge>{config.review.kind}</Badge>
          <Button variant="soft" disabled={pending} onClick={() => onEdit(config.id)}>Edit</Button>
        </div>
      </Card>)}
      {!settings && <div><Button onClick={() => onEdit('')}>Configure agents</Button></div>}
      {settings && <Card>
        <form className="stack" onSubmit={event => {
          event.preventDefault();
          void save(async () => { const next = await api.agentConfig(connection, form, true); onEdit(next.id); });
        }}>
          <div className="row-between">
            <Heading as="h3" size="4">{form.id ? 'Edit agent' : 'New agent'}</Heading>
            {form.id && <Button type="button" variant="soft" disabled={pending} onClick={() => onEdit('')}>New agent</Button>}
          </div>
          <label>Name <TextField.Root required maxLength={100} value={form.name}
            onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <label>Codex model <TextField.Root required maxLength={100} value={form.model}
            onChange={event => setForm({ ...form, model: event.target.value })} /></label>
          <label>Review method <select value={form.review.kind} onChange={event =>
            setForm({ ...form, review: { kind: event.target.value as AgentConfig['review']['kind'], text: '' } })}>
            <option value="instructions">Direct instructions</option><option value="skill">Registered skill</option><option value="plugin">Registered plugin</option>
          </select></label>
          <label>{form.review.kind === 'instructions' ? 'Defensive review instructions' : 'Registered name'}
            <TextArea required maxLength={8000} value={form.review.text}
              onChange={event => setForm({ ...form, review: { ...form.review, text: event.target.value } })} />
          </label>
          <fieldset><legend>Allowed context</legend><Permissions value={form} set={setForm} /></fieldset>
          <div className="toolbar">
            <Button type="submit" disabled={pending}>Save agent</Button>
            {form.id && <Button type="button" color="red" variant="soft" disabled={pending}
              onClick={() => void save(async () => { await api.agentDeleteConfig(connection, form.id, true); onEdit(''); })}>Delete agent</Button>}
          </div>
        </form>
      </Card>}
    </>}
  </div>;
}
