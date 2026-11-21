import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceApi } from './api';
const workspace: WorkspaceApi = { status: () => ipcRenderer.invoke('workspace:status') };
contextBridge.exposeInMainWorld('workspace', workspace);
