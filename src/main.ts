import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './store';
import { credentials } from './credentials';
import type { WorkspaceStatus } from './api';

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
  app.once('will-quit', () => db.close());
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  ipcMain.handle('workspace:status', (event, ...args): WorkspaceStatus => {
    if (args.length || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== page) {
      throw new Error('Invalid workspace request');
    }
    return {
      accounts: Number(db.prepare('SELECT count(*) AS total FROM connections').get()?.total),
      credentialStorageAvailable: vault.available(),
    };
  });
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
