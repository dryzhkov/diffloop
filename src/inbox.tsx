import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Comment, DraftTarget, DeviceCode, PullResult, Resource, Review, SavedQuery, WorkspaceApi, WorkspaceStatus } from './api';
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
    <input aria-label={saved ? 'Saved GitHub query' : 'New GitHub query'} value={query} maxLength={256} required
      placeholder="is:open review-requested:@me" onChange={event => setQuery(event.target.value)} />
    <button disabled={disabled || !query.trim() || query === saved?.query}>{saved ? 'Save' : 'Add query'}</button>
    {onDelete && <button type="button" disabled={deleteDisabled} onClick={onDelete}>Delete</button>}
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
    <button onClick={async () => {
      if (content !== null) return setContent(null);
      try {
        setError('');
        setContent(await api.readFile(id, path, side, blob));
      } catch (failure) {
        setError(message(failure));
      }
    }}>{content === null ? 'Show' : 'Hide'} cached {side} · {path}</button>
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
  const [draftTarget,setDraftTarget] = useState<DraftTarget>({kind:'pr'});
  function compose(t: DraftTarget) {setDraftTarget(t); document.getElementById('draft-panel')?.scrollIntoView();}
  const [path, choosePath] = useState('');
  const file = diff.data?.files.find(item => item.path === path) ?? diff.data?.files[0];
  return <section className="review">
    <h2>{metadata.data?.title ?? 'Pull request'}</h2>
    <CacheStatus resource={metadata} />
    {metadata.data && <>
      <p>{metadata.data.author ?? 'Unknown author'} · {metadata.data.state}{metadata.data.isDraft && ' · draft'}</p>
      <p className="body">{metadata.data.body}</p>
    </>}
    <h3>Changed files</h3>
    <CacheStatus resource={diff} revision={metadata.revision} />
    <CacheStatus resource={files} revision={metadata.revision} />
    {diff.data && <>
      <p className="revision">Target {diff.data.baseSha}<br />Diff base {diff.data.diffBaseSha ?? 'unavailable'}<br />Head {diff.data.headSha}</p>
      {diff.data.files.length === 0 && <p>No cached file changes.</p>}
      {file && <div>
        <label>Changed file <select value={file.path} onChange={event => choosePath(event.target.value)}>
          {diff.data.files.map(item => <option key={item.path} value={item.path}>{item.path} · {item.status}</option>)}
        </select></label>
        {file.previousPath && <p>Previous path {file.previousPath}</p>}
        <DiffView key={JSON.stringify([file.path, diff.data.diffBaseSha, diff.data.headSha, diff.cachedAt])}
          onDraft={anchor => compose({kind:'inline',anchor})} file={file} diff={diff.data} threads={threads.revision === diff.revision ? threads.data ?? [] : []} />
        {([['base', file.previousPath ?? file.path], ['head', file.path]] as const).map(([side, path]) => {
          const cached = files.data?.find(item => item.side === side && item.path === path);
          if ((side === 'base' && file.status === 'added') || (side === 'head' && file.status === 'removed')) return null;
          if (!cached || files.revision !== diff.revision) return <p key={side}>{side} content unavailable for this revision.</p>;
          return cached.blob ?
            <CachedFile key={side + cached.blob} id={id} side={side} path={path} blob={cached.blob} /> :
            <p key={side}>{side} content unavailable · {cached.error}</p>;
        })}
      </div>}
    </>}
    <h3>Discussion</h3>
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
        {thread.comments.filter(c=>!c.replyTo && /#discussion_r\d+$/.test(c.url)).map(c=>
          <button key={c.id} onClick={()=>compose({kind:'reply',parent:c.url.split('#discussion_r')[1]})}>Draft reply</button>)}
        <button onClick={()=>compose({kind:'thread',thread:thread.id,resolve:!thread.isResolved})}>
          Prepare {thread.isResolved?'reopen':'resolve'} action</button>
        {thread.comments.map(comment => <Discussion key={comment.id} comment={comment} />)}
      </details>)}
    </>}
    {metadata.data && <DraftsView onPublished={onPublished} pr={id} head={metadata.data.headSha} target={draftTarget} setTarget={setDraftTarget}/>}
  </section>;
}

function Inbox() {
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
    setReview(undefined);
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

  return <main><header>Diffloop</header><h1>Review inbox</h1>
    <details open={status?.accounts === 0 || undefined}>
      <summary>Connect or update a GitHub account</summary>
      {status && !status.credentialStorageAvailable && <p>OS credential storage is unavailable.</p>}
      <div className="toolbar">
        <button disabled={!!busy || !oauthConfigured || !status?.credentialStorageAvailable} onClick={() => {
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
        }}>Sign in with GitHub</button>
        {oauthConfigured && <label>
          <input className="option" type="checkbox" checked={privateRepos} disabled={!!busy}
            onChange={event => setPrivateRepos(event.target.checked)} /> Request private repository access
        </label>}
      </div>
      {!oauthConfigured && <p>GitHub sign-in requires a configured OAuth client ID.</p>}
      {privateRepos && <p>GitHub grants broad repository permissions with this option. Diffloop uses them for Pull.</p>}
      {device && <div>
        <p>Enter <code>{device.userCode}</code> on GitHub before {date(new Date(device.expiresAt).toISOString())}.</p>
        <button onClick={() => void api.openOAuth().catch(failure => setError(message(failure)))}>Open github.com/login/device</button>
        <button onClick={() => void api.cancelOAuth().catch(failure => setError(message(failure)))}>Cancel sign-in</button>
      </div>}
      {signedIn && <p role="status">GitHub sign-in completed.</p>}
      <form onSubmit={event => {
        event.preventDefault();
        const pat = token.trim();
        setToken('');
        void run('Connecting…', () => api.connect(pat));
      }}>
        <input type="password" aria-label="GitHub personal access token" placeholder="GitHub personal access token"
          autoComplete="off" value={token} onChange={event => setToken(event.target.value)} />
        <button disabled={!!busy || !token.trim() || !status?.credentialStorageAvailable}>Connect with PAT</button>
      </form>
    </details>
    {error && <p role="alert">{error}</p>}
    {busy && !pullingId && <p role="status">{busy}</p>}
    {connection && <section>
      <div className="toolbar">
        <label>GitHub account <select value={connection.id} onChange={event => {
          setAccount(event.target.value);
          setSelected('');
          setResult(undefined);
        }} disabled={!!busy}>
          {status?.connections.map(item => <option key={item.id} value={item.id}>{item.login}</option>)}
        </select></label>
        <button disabled={!canPull} onClick={() => pull()}>Pull</button>
        {pullingId && <button onClick={() => api.cancelPull(pullingId).catch(failure => setError(message(failure)))}>Cancel Pull</button>}
        {connection.status !== 'disconnected' && <button disabled={!!busy && busy !== 'Pulling from GitHub…'} onClick={async () => {
          try {
            await api.disconnect(connection.id);
            setStatus(await api.status());
          } catch (failure) {
            setError(message(failure));
          }
        }}>Disconnect</button>}
      </div>
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
      <details open={!status?.queries.some(query => query.connectionId === connection.id) || undefined}>
        <summary>Saved queries</summary>
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
      </details>
      <h2>{showTracked ? 'Tracked pull requests' : 'Needs attention'}</h2>
      <button aria-pressed={showTracked} onClick={() => setShowTracked(!showTracked)}>
        {showTracked ? 'Show needs attention' : 'Show all tracked PRs'} ({showTracked ? active.length : tracked.length})
      </button>
      {(showTracked ? tracked : active).map(pr => <div key={pr.id}>
        <button className="pr" aria-pressed={pr.id === selected} onClick={() => setSelected(pr.id)}>
          {pr.repository} #{pr.number} · {pr.title ?? 'Metadata unavailable'} · {pr.state}
        </button>
        {pr.snoozed && <span>Snoozed · </span>}
        {[...new Set(pr.reasons.map(reason => reasonLabels[reason.kind]))].join(' · ')}
        {!pr.attentionReady && pr.state === 'open' && <span>Attention data unavailable</span>}
        {pr.state === 'open' && pr.reasons.length > 0 && <div className="toolbar">
          <button disabled={!!busy} onClick={() => run('Marking handled…',
            () => api.markHandled(pr.id, pr.reasons.map(reason => reason.key)))}>Mark handled</button>
          {!pr.snoozed && <button disabled={!!busy} onClick={() => run('Snoozing…', () => api.snooze(pr.id))}>Snooze</button>}
        </div>}
      </div>)}
      {!(showTracked ? tracked : active).length && <p>{showTracked ? 'No pull requests cached.' : 'No PRs flagged for attention.'}</p>}
      {review?.id === selected && <>
        <button disabled={!canPull} onClick={() => pull(selected)}>Refresh this PR</button>
        <ReviewPane onPublished={async () => setStatus(await api.status())} key={selected} id={selected} review={review.value} />
      </>}
    </section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Inbox />);
