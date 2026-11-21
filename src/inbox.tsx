import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkspaceApi, WorkspaceStatus } from './api';
import './inbox.css';

declare global { interface Window { workspace: WorkspaceApi } }
function Inbox() {
  const [status, setStatus] = useState<WorkspaceStatus>();
  const [failed, setFailed] = useState(false);
  useEffect(() => { window.workspace.status().then(setStatus).catch(() => setFailed(true)); }, []);
  return <main><header>Diffloop</header><h1>Review inbox</h1>
    <section aria-live="polite">
      {failed ? 'Could not read the local workspace.' : !status ? 'Opening workspace…' :
        status.accounts === 0 ? 'No GitHub accounts connected.' : 'No pull requests cached.'}
      {status && !status.credentialStorageAvailable && <p>OS credential storage is unavailable.</p>}
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Inbox />);
