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
  drafts: (...args) => ipcRenderer.invoke('workspace:drafts', ...args),
  addDraft: (...args) => ipcRenderer.invoke('workspace:addDraft', ...args),
  editDraft: (...args) => ipcRenderer.invoke('workspace:editDraft', ...args),
  discardDraft: (...args) => ipcRenderer.invoke('workspace:discardDraft', ...args),
  pushDrafts: (...args) => ipcRenderer.invoke('workspace:pushDrafts', ...args),
  checkDraft: (...args) => ipcRenderer.invoke('workspace:checkDraft', ...args),
  resolveDraft: (...args) => ipcRenderer.invoke('workspace:resolveDraft', ...args),
  openDraftUrl: (...args) => ipcRenderer.invoke('workspace:openDraftUrl', ...args),
  markHandled: (id, keys) => ipcRenderer.invoke('workspace:markHandled', id, keys),
  snooze: id => ipcRenderer.invoke('workspace:snooze', id),
  cancelPull: id => ipcRenderer.invoke('workspace:cancelPull', id),
  pullProgress: id => ipcRenderer.invoke('workspace:pullProgress', id),
  pull: (connectionId, prId) => ipcRenderer.invoke('workspace:pull', connectionId, prId),
  review: id => ipcRenderer.invoke('workspace:review', id),
  readFile: (id, path, side, blob) => ipcRenderer.invoke('workspace:readFile', id, path, side, blob),
};
contextBridge.exposeInMainWorld('workspace', workspace);
