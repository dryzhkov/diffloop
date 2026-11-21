import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceApi } from './api';

const workspace: WorkspaceApi = {
  oauthAvailable: () => ipcRenderer.invoke('workspace:oauthAvailable'),
  startOAuth: privateRepos => ipcRenderer.invoke('workspace:startOAuth', privateRepos),
  openOAuth: () => ipcRenderer.invoke('workspace:openOAuth'),
  finishOAuth: () => ipcRenderer.invoke('workspace:finishOAuth'),
  cancelOAuth: () => ipcRenderer.invoke('workspace:cancelOAuth'),
  status: () => ipcRenderer.invoke('workspace:status'),
  disconnect: id => ipcRenderer.invoke('workspace:disconnect', id),
  connect: token => ipcRenderer.invoke('workspace:connect', token),
  saveQuery: (connectionId, query, id) => ipcRenderer.invoke('workspace:saveQuery', connectionId, query, id),
  deleteQuery: id => ipcRenderer.invoke('workspace:deleteQuery', id),
  pull: (connectionId, prId) => ipcRenderer.invoke('workspace:pull', connectionId, prId),
  review: id => ipcRenderer.invoke('workspace:review', id),
  readFile: (id, path, side, blob) => ipcRenderer.invoke('workspace:readFile', id, path, side, blob),
};
contextBridge.exposeInMainWorld('workspace', workspace);
