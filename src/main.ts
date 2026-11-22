import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store';
import { configureCredentialStorage, credentials } from './credentials';
import { registerWorkspace } from './ipc';
import { githubOAuth } from './oauth';
import { workspace } from './workspace';

configureCredentialStorage();

const page = pathToFileURL(join(__dirname, 'index.html')).href;
function openWindow() {
  const window = new BrowserWindow({
    width: 980, height: 680,
    webPreferences: {
      preload: join(__dirname, 'preload.js'), sandbox: true,
      nodeIntegration: false, contextIsolation: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  return window.loadURL(page);
}

app.whenReady().then(async () => {
  const db = openStore(join(app.getPath('userData'), 'workspace.sqlite'));
  const vault = credentials(db);
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  const service = workspace(db, vault, join(app.getPath('userData'), 'code-cache'));
  app.once('will-quit', () => {
    service.stopAgentRuns();
    db.close();
  });
  const oauth = githubOAuth(process.env.DIFFLOOP_GITHUB_OAUTH_CLIENT_ID, service.connect);
  registerWorkspace(page, service, oauth);
  app.on('window-all-closed', oauth.cancel);
  await openWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) void openWindow();
  });
}).catch(error => {
  console.error(error);
  app.exit(1);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
