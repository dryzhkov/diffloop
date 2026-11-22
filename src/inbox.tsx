import { Badge, Button, Callout, Card, Heading, Tabs, Text, TextField, Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import { AgentDirectory, AgentsView } from './agents-view';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentScope, Comment, DraftTarget, DeviceCode, PullResult, Resource, Review, SavedQuery, Threads, WorkspaceApi, WorkspaceStatus } from './api';
import './inbox.css';
import { DraftsView } from './drafts-view';
import { DiffView } from './diff-view';

declare global { interface Window { workspace: WorkspaceApi } }
const api = window.workspace;
const reasonLabels = {
  direct_request: 'Review requested from you', team_request: 'Team review requested',
  explicit_rerequest: 'Review requested again', author_reply: 'Author replied to your thread',
  commits_after_changes_requested: 'New commits since you requested changes',
};
const date = (value: string) => new Date(value).toLocaleString();
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : 'Workspace request failed';

function QueryEditor({ saved, disabled, deleteDisabled = disabled, onSave, onDelete }: {
  saved?: SavedQuery; disabled: boolean; deleteDisabled?: boolean; onSave: (query: string) => Promise<boolean>; onDelete?: () => void;
}) {
  const [query, setQuery] = useState(saved?.query ?? '');
  return <form onSubmit={async event => {
    event.preventDefault();
    if (await onSave(query) && !saved) setQuery('');
  }}>
    <TextField.Root aria-label={saved ? 'Saved GitHub query' : 'New GitHub query'} value={query} maxLength={256} required
      placeholder="is:open review-requested:@me" onChange={event => setQuery(event.target.value)} />
    <Button disabled={disabled || !query.trim() || query === saved?.query}>{saved ? 'Save' : 'Add query'}</Button>
    {onDelete && <Button type="button" color="red" variant="soft" disabled={deleteDisabled} onClick={onDelete}>Delete</Button>}
  </form>;
}

function CacheStatus({ resource, revision }: { resource: Resource<unknown>; revision?: string | null }) {
  return <p className="status">
    {resource.data ? `Cached ${date(resource.cachedAt!)}` : 'Unavailable offline'}
    {resource.data !== null && !resource.complete && ' · Incomplete'}
    {resource.data !== null && revision && revision !== resource.revision && ' · Older PR revision'}
    {resource.error && ` · ${resource.error}`}
  </p>;
}

function CachedFile({ id, path, side, blob }: { id: string; path: string; side: 'base' | 'head'; blob: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  return <div>
    <Button size="1" variant="soft" onClick={async () => {
      if (content !== null) return setContent(null);
      try {
        setError('');
        setContent(await api.readFile(id, path, side, blob));
      } catch (failure) {
        setError(message(failure));
      }
    }}>{content === null ? 'Show' : 'Hide'} cached {side} · {path}</Button>
    {error && <p role="alert">{error}</p>}
    {content !== null && <pre>{content || '(Empty file)'}</pre>}
  </div>;
}

function Discussion({ comment }: { comment: Comment }) {
  return <article><strong>{comment.author ?? 'Unknown author'}</strong>
    {comment.createdAt && <> · {date(comment.createdAt)}</>}
    {comment.body && <p className="body">{comment.body}</p>}
  </article>;
}

function ReviewPane({ id, review, onPublished }: { id: string; review: Review; onPublished: () => Promise<void> }) {
  const { metadata, diff, files, comments, reviews, threads } = review;
  const [scope, setScope] = useState<AgentScope>({ kind: 'pr' });
  const [agentDraftRevision, advanceDrafts] = useState(0);
  function chooseScope(next: AgentScope) {
    setScope(next);
    setReviewTab('agents');
  }
  const [draftTarget, setDraftTarget] = useState<DraftTarget>({ kind: 'pr' });
  const [reviewTab, setReviewTab] = useState('files');
  function compose(t: DraftTarget) {
    setDraftTarget(t);
    setReviewTab('drafts');
  }
  function threadContent(thread: Threads['threads'][number]) {
    return <>
      {thread.comments.map(comment => <Discussion key={comment.id} comment={comment} />)}
      <div className="toolbar">
        {thread.comments.filter(comment => !comment.replyTo && /#discussion_r\d+$/.test(comment.url)).map(comment =>
          <Button key={comment.id} size="1" variant="soft" onClick={() => compose({ kind: 'reply', parent: comment.url.split('#discussion_r')[1] })}>Draft reply</Button>)}
        <Button size="1" variant="soft" onClick={() => compose({ kind: 'thread', thread: thread.id, resolve: !thread.isResolved })}>
          {thread.isResolved ? 'Reopen' : 'Resolve'} thread
        </Button>
        <Button size="1" variant="soft" onClick={() => chooseScope({ kind: 'thread', thread: thread.id })}>Review thread</Button>
      </div>
    </>;
  }
  const [path, choosePath] = useState('');
  const file = diff.data?.files.find(item => item.path === path) ?? diff.data?.files[0];
  return <section className="review">
    <h2>{metadata.data?.title ?? 'Pull request'}</h2>
    <Tabs.Root value={reviewTab} onValueChange={setReviewTab}>
      <Tabs.List>
        <Tabs.Trigger value="files">Files</Tabs.Trigger>
        <Tabs.Trigger value="discussion">Discussion</Tabs.Trigger>
        <Tabs.Trigger value="drafts">Drafts</Tabs.Trigger>
        <Tabs.Trigger value="agents">Agent review</Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="files" forceMount hidden={reviewTab !== 'files'} className="tab-panel">
        {(!diff.complete || diff.revision !== metadata.revision) && <CacheStatus resource={diff} revision={metadata.revision} />}
        {diff.data ? <>
          {diff.data.files.length === 0 && <p>No cached file changes.</p>}
          {file && <div className="files-layout">
            <nav aria-label="Changed files" className="file-list">
              {diff.data.files.map(item => <Button key={item.path} variant={file.path === item.path ? 'soft' : 'ghost'}
                aria-current={file.path === item.path ? 'true' : undefined} title={item.path} onClick={() => choosePath(item.path)}>
                <span>{item.path}</span>
              </Button>)}
            </nav>
            <div className="file-content">
              <DiffView key={JSON.stringify([file.path, diff.data.diffBaseSha, diff.data.headSha, diff.cachedAt])}
                onReview={anchor => chooseScope({ kind: 'selection', anchor })}
                onDraft={async (anchor, body) => {
                  await api.addDraft(id, { kind: 'inline', anchor }, diff.data!.headSha, body);
                  advanceDrafts(n => n + 1);
                }}
                renderThread={threadContent} file={file} diff={diff.data}
                canDraft={!!diff.data.diffBaseSha && diff.revision === metadata.revision}
                threads={threads.revision === diff.revision ? threads.data ?? [] : []} />
              <details>
                <summary>Cached file contents</summary>
                {(!files.complete || files.revision !== diff.revision) && <CacheStatus resource={files} revision={diff.revision} />}
                {([['base', file.previousPath ?? file.path], ['head', file.path]] as const).map(([side, path]) => {
                  const cached = files.data?.find(item => item.side === side && item.path === path);
                  if ((side === 'base' && file.status === 'added') || (side === 'head' && file.status === 'removed')) return null;
                  if (!cached || files.revision !== diff.revision) return <p key={side}>{side} content unavailable for this revision.</p>;
                  return cached.blob ?
                    <CachedFile key={side + cached.blob} id={id} side={side} path={path} blob={cached.blob} /> :
                    <p key={side}>{side} content unavailable · {cached.error}</p>;
                })}
              </details>
            </div>
          </div>}
        </> : <Text color="gray">No diff cached.</Text>}
      </Tabs.Content>
    <Tabs.Content value="discussion" className="tab-panel">
        <CacheStatus resource={metadata} />
        {metadata.data && <>
          <p>{metadata.data.author ?? 'Unknown author'} · {metadata.data.state}{metadata.data.isDraft && ' · draft'}</p>
          <p className="body">{metadata.data.body}</p>
        </>}
        <h4>General comments</h4>
        <CacheStatus resource={comments} revision={metadata.revision} />
        {comments.data?.map(comment => <Discussion key={comment.id} comment={comment} />)}
        <h4>Reviews</h4>
        <CacheStatus resource={reviews} revision={metadata.revision} />
        {reviews.data?.map(review => <details key={review.id}>
          <summary>{review.author ?? 'Unknown author'} · {review.state}</summary><Discussion comment={review} />
        </details>)}
        <h4>Inline threads</h4>
        <CacheStatus resource={threads} revision={metadata.revision} />
        {threads.data && <>
          {threads.data.length === 0 && <p>No cached inline threads.</p>}
          {threads.data.map(thread => <details key={thread.id} id={'thread-' + thread.id}>
            <summary>{thread.path}{thread.line && `:${thread.line}`} · {thread.isResolved ? 'Resolved' : 'Unresolved'}
              {thread.isOutdated && ' · Outdated'}</summary>
            {threadContent(thread)}
          </details>)}
        </>}
      </Tabs.Content>
    <Tabs.Content value="agents" className="tab-panel">
        {metadata.data && <AgentsView pr={id} scope={scope} clearScope={() => setScope({ kind: 'pr' })}
          head={metadata.data.headSha} base={metadata.data.baseSha} diffBase={diff.data?.diffBaseSha ?? null}
          onDraftsChanged={() => advanceDrafts(n => n + 1)} />}
      </Tabs.Content>
    <Tabs.Content value="drafts" forceMount hidden={reviewTab !== 'drafts'} className="tab-panel">
        {metadata.data && <DraftsView agentDraftRevision={agentDraftRevision} onPublished={onPublished} pr={id} head={metadata.data.headSha} target={draftTarget} setTarget={setDraftTarget}/>}
      </Tabs.Content>
    </Tabs.Root>
  </section>;
}

function Inbox() {
  const [page, setPage] = useState<'home' | 'agents' | 'settings'>('home');
  const [settingsTab, setSettingsTab] = useState('connections');
  const [editingAgent, setEditingAgent] = useState('');
  const [status, setStatus] = useState<WorkspaceStatus>();
  const [showTracked, setShowTracked] = useState(false);
  const [account, setAccount] = useState('');
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<{ id: string; value: Review }>();
  const [token, setToken] = useState('');
  const [oauthConfigured, setOAuthConfigured] = useState(false);
  const [privateRepos, setPrivateRepos] = useState(false);
  const [device, setDevice] = useState<DeviceCode>();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<PullResult>();
  const connection = status?.connections.find(item => item.id === account) ?? status?.connections[0];
  const tracked = status?.pullRequests.filter(pr => pr.connectionId === connection?.id) ?? [];
  const active = tracked.filter(pr => pr.state === 'open' && !pr.snoozed && pr.reasons.length);
  const [progress, setProgress] = useState('');
  const pullingId = busy === 'Pulling from GitHub…' ? connection?.id : undefined;
  useEffect(() => {
    if (!pullingId) return;
    let active = true;
    const update = () => api.pullProgress(pullingId).then(value => {
      if (active) setProgress(value ?? '');
    }).catch(() => {});
    void update();
    const timer = setInterval(update, 750);
    return () => { active = false; clearInterval(timer); };
  }, [pullingId]);
  const canPull = !!connection && !busy && !['disconnected', 'reauth_required'].includes(connection.status) &&
    status?.credentialStorageAvailable;
  const pull = (prId?: string) => {
    if (!connection) return;
    setResult(undefined);
    setProgress('');
    void run('Pulling from GitHub…', async () => setResult(await api.pull(connection.id, prId)));
  };
  useEffect(() => { api.status().then(setStatus).catch(failure => setError(message(failure))); }, []);
  useEffect(() => { api.oauthAvailable().then(setOAuthConfigured).catch(failure => setError(message(failure))); }, []);
  useEffect(() => {
    let active = true;
    setReview(current => current?.id === selected ? current : undefined);
    if (selected) api.review(selected).then(value => {
      if (active) setReview({ id: selected, value });
    }).catch(failure => {
      if (active) setError(message(failure));
    });
    return () => { active = false; };
  }, [selected, status]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await action();
      setStatus(await api.status());
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    } finally {
      setBusy('');
    }
  }

  const editAgent = (id: string) => {
    setEditingAgent(id);
    setSettingsTab('agents');
    setPage('settings');
  };
  const accountPicker = connection && <label className="account-picker">GitHub account <select value={connection.id}
    onChange={event => {
      setAccount(event.target.value);
      setSelected('');
      setResult(undefined);
      setEditingAgent('');
    }} disabled={!!busy}>
    {status?.connections.map(item => <option key={item.id} value={item.id}>{item.login}</option>)}
  </select></label>;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">Diffloop</div>
      <nav aria-label="Main navigation">
        {(['home', 'agents', 'settings'] as const).map(item => <Button key={item} variant={page === item ? 'soft' : 'ghost'}
          aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>
          {item === 'home' ? 'Home' : item === 'agents' ? 'Agents' : 'Settings'}
        </Button>)}
      </nav>
    </aside>
    <main className="main-pane">
    {error && <Callout.Root color="red"><Callout.Text role="alert">{error}</Callout.Text></Callout.Root>}
    {busy && !pullingId && <p role="status">{busy}</p>}
    {page === 'settings' && <>
      <Heading as="h1" size="7">Settings</Heading>
      {accountPicker}
      <Tabs.Root value={settingsTab} onValueChange={setSettingsTab}>
        <Tabs.List>
          <Tabs.Trigger value="connections">GitHub connections</Tabs.Trigger>
          <Tabs.Trigger value="queries">Saved queries</Tabs.Trigger>
          <Tabs.Trigger value="agents">Agent configuration</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="connections" className="tab-panel">
        <Card>
          <Heading as="h2" size="4">Connect a GitHub account</Heading>
             {status && !status.credentialStorageAvailable && <p>OS credential storage is unavailable.</p>}
             <div className="toolbar">
               <Button disabled={!!busy || !oauthConfigured || !status?.credentialStorageAvailable} onClick={() => {
                 setSignedIn(false);
                 void run('Waiting for GitHub sign-in…', async () => {
                   setDevice(await api.startOAuth(privateRepos));
                   try {
                     await api.finishOAuth();
                     setSignedIn(true);
                   } finally {
                     setDevice(undefined);
                   }
                 });
               }}>Sign in with GitHub</Button>
               {oauthConfigured && <label>
                 <input className="option" type="checkbox" checked={privateRepos} disabled={!!busy}
                   onChange={event => setPrivateRepos(event.target.checked)} /> Request private repository access
               </label>}
             </div>
             {!oauthConfigured && <p>GitHub sign-in requires a configured OAuth client ID.</p>}
             {privateRepos && <p>GitHub grants broad repository permissions with this option. Diffloop uses them for Pull.</p>}
             {device && <div>
               <p>Enter <code>{device.userCode}</code> on GitHub before {date(new Date(device.expiresAt).toISOString())}.</p>
               <Button variant="soft" onClick={() => void api.openOAuth().catch(failure => setError(message(failure)))}>Open github.com/login/device</Button>
               <Button variant="soft" onClick={() => void api.cancelOAuth().catch(failure => setError(message(failure)))}>Cancel sign-in</Button>
             </div>}
             {signedIn && <p role="status">GitHub sign-in completed.</p>}
             <form onSubmit={event => {
               event.preventDefault();
               const pat = token.trim();
               setToken('');
               void run('Connecting…', () => api.connect(pat));
             }}>
               <TextField.Root type="password" aria-label="GitHub personal access token" placeholder="GitHub personal access token"
                 autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
               <Button disabled={!!busy || !token.trim() || !status?.credentialStorageAvailable}>Connect with PAT</Button>
             </form>
        </Card>
        {connection && <Card className="connection-card">
          <div className="row-between">
            <Heading as="h2" size="4">{connection.login}</Heading>
            <Badge>{connection.status.replaceAll('_', ' ')}</Badge>
            {connection.status !== 'disconnected' && <Button variant="soft" disabled={!!busy && busy !== 'Pulling from GitHub…'} onClick={async () => {
              try {
                await api.disconnect(connection.id);
                setStatus(await api.status());
              } catch (failure) {
                setError(message(failure));
              }
            }}>Disconnect</Button>}
          </div>
        </Card>}
          </Tabs.Content>
        <Tabs.Content value="queries" className="tab-panel">
          {connection ? <Card>
            <Heading as="h2" size="4">Saved queries</Heading>
            {status?.queries.filter(query => query.connectionId === connection.id).map(query =>
              <QueryEditor key={query.id} saved={query} disabled={!!busy} deleteDisabled={!!busy && !pullingId}
                onSave={value => run('Saving query…', () => api.saveQuery(connection.id, value, query.id))}
                onDelete={async () => {
                  try {
                    await api.deleteQuery(query.id);
                    setStatus(current => current && { ...current, queries: current.queries.filter(item => item.id !== query.id) });
                  } catch (failure) { setError(message(failure)); }
                }} />)}
            <QueryEditor key={connection.id} disabled={!!busy}
              onSave={value => run('Saving query…', () => api.saveQuery(connection.id, value))} />
          </Card> : <Text color="gray">Connect a GitHub account to add queries.</Text>}
          </Tabs.Content>
        <Tabs.Content value="agents" className="tab-panel">
          {connection ? <AgentDirectory key={connection.id} connection={connection.id} settings editing={editingAgent}
            onEdit={setEditingAgent} /> : <Text color="gray">Connect a GitHub account to configure agents.</Text>}
          </Tabs.Content>
      </Tabs.Root>
    </>}
    {page === 'agents' && <>
      <Heading as="h1" size="7">Agents</Heading>
      {accountPicker}
      {connection ? <AgentDirectory key={connection.id} connection={connection.id} settings={false} editing="" onEdit={editAgent} /> :
        <Button variant="soft" onClick={() => { setSettingsTab('connections'); setPage('settings'); }}>Connect a GitHub account</Button>}
    </>}
    {page === 'home' && <>
      <div className="row-between page-heading">
        {selected ? <Button variant="soft" onClick={() => setSelected('')}>← Review inbox</Button> :
          <Heading as="h1" size="7">Review inbox</Heading>}
        {connection && <div className="toolbar">
          {accountPicker}
          <Button disabled={!canPull} onClick={() => pull(selected || undefined)}>{selected ? 'Refresh PR' : 'Pull'}</Button>
          {pullingId && <Button variant="soft" onClick={() => api.cancelPull(pullingId).catch(failure => setError(message(failure)))}>Cancel Pull</Button>}
        </div>}
      </div>
      {!connection && status && <Card><Text as="p" color="gray">Connect a GitHub account and add a saved query to pull your review queue.</Text>
        <Button onClick={() => { setSettingsTab('connections'); setPage('settings'); }}>GitHub settings</Button>
      </Card>}
      {connection && <>
      {pullingId && <div className="pull-activity" role="status">
        <progress aria-label="Pull in progress" />
        <span>{progress || 'Preparing Pull…'}</span>
      </div>}
      <p className="status">
        {connection.lastPulledAt ? `Last Pull attempt ${date(connection.lastPulledAt)}` : 'No Pull yet'}
        {connection.status === 'reauth_required' && ' · Connect again to update your token'}
        {connection.status === 'disconnected' && ' · Disconnected'}
        {connection.status === 'error' && ' · Last Pull had errors'}
      </p>
      {result && <details open={!!result.errors.length}>
        <summary>{result.refreshed} PRs refreshed · {result.errors.length} issues</summary>
        <ul>{result.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
      </details>}
      {!selected && <>
        <div className="row-between list-heading">
          <Heading as="h2" size="4">{showTracked ? 'Tracked pull requests' : 'Needs attention'}</Heading>
          <Button variant="soft" size="2" onClick={() => setShowTracked(!showTracked)}>
            {showTracked ? `Needs attention (${active.length})` : `All tracked (${tracked.length})`}
          </Button>
        </div>
        <div className="stack">
          {(showTracked ? tracked : active).map(pr => <Card key={pr.id} className="pr-card">
            <div className="row-between">
              <button className="pr-link" onClick={() => setSelected(pr.id)}>
                <span className="pr-reference">{pr.repository} #{pr.number}</span>
                <strong>{pr.title ?? 'Metadata unavailable'}</strong>
              </button>
              {pr.state !== 'open' && <Badge color="gray">{pr.state}</Badge>}
            </div>
            <div className="toolbar">
              {pr.snoozed && <Badge color="gray">Snoozed</Badge>}
              {[...new Set(pr.reasons.map(reason => reason.kind))].map(kind =>
                <Badge key={kind} variant="soft">{reasonLabels[kind]}</Badge>)}
              {!pr.attentionReady && pr.state === 'open' && <Text color="gray" size="2">Attention data unavailable</Text>}
            </div>
            {pr.state === 'open' && pr.reasons.length > 0 && <div className="toolbar">
              <Button size="1" variant="ghost" disabled={!!busy} onClick={() => run('Marking handled…',
                () => api.markHandled(pr.id, pr.reasons.map(reason => reason.key)))}>Mark handled</Button>
              {!pr.snoozed && <Button size="1" variant="ghost" disabled={!!busy}
                onClick={() => run('Snoozing…', () => api.snooze(pr.id))}>Snooze</Button>}
            </div>}
          </Card>)}
          {!(showTracked ? tracked : active).length && <Card>
            <Text color="gray">{showTracked ? 'No pull requests cached.' : 'No PRs need attention.'}</Text>
          </Card>}
        </div>
      </>}
      {selected && review?.id !== selected && !error && <Text color="gray" role="status">Loading review…</Text>}
      {review?.id === selected && <ReviewPane onPublished={async () => setStatus(await api.status())}
        key={selected} id={selected} review={review.value} />}
      </>}
    </>}
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);

function App() {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return <Theme appearance={dark ? 'dark' : 'light'} accentColor="iris" grayColor="slate" radius="medium">
    <Inbox />
  </Theme>;
}
