import { ipcMain, shell } from 'electron';
import { verificationUrl, type githubOAuth } from './oauth';
import type { workspace } from './workspace';

type Handler = (...args: unknown[]) => unknown;
type Validator<T> = (value: unknown) => T;
function string(max: number, pattern?: RegExp): Validator<string> {
  return value => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || (pattern && !pattern.test(value))) {
      throw new Error('Invalid workspace argument');
    }
    return value;
  };
}

const id = string(36, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const token = string(512, /^[\w]+$/);
const query = string(256, /^[^\r\n\u0000]+$/);
const path = string(4096, /^[^\u0000]+$/);
const sha = string(40, /^[a-f0-9]{40}$/);
const side: Validator<'base' | 'head'> = value => {
  if (value !== 'base' && value !== 'head') throw new Error('Invalid file side');
  return value;
};

export function registerWorkspace(page: string, service: ReturnType<typeof workspace>, oauth: ReturnType<typeof githubOAuth>) {
  function handle(channel: string, arities: number[], handler: Handler) {
    ipcMain.handle(`workspace:${channel}`, (event, ...args: unknown[]) => {
      if (!arities.includes(args.length) || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== page) {
        throw new Error('Invalid workspace request');
      }
      return handler(...args);
    });
  }

  handle('oauthAvailable', [0], () => oauth.configured);
  handle('startOAuth', [1], async privateRepos => {
    if (typeof privateRepos !== 'boolean') throw new Error('Invalid repository access selection');
    if (!(await service.status()).credentialStorageAvailable) throw new Error('OS credential encryption unavailable');
    return oauth.start(privateRepos);
  });
  handle('openOAuth', [0], () => shell.openExternal(verificationUrl));
  handle('finishOAuth', [0], oauth.finish);
  handle('cancelOAuth', [0], oauth.cancel);
  handle('status', [0], service.status);
  handle('disconnect', [1], value => service.disconnect(id(value)));
  handle('connect', [1], value => service.connect(token(value)));
  handle('saveQuery', [2, 3], (connection, expression, existing) =>
    service.saveQuery(id(connection), query(expression).trim(), existing === undefined ? undefined : id(existing)));
  handle('deleteQuery', [1], value => service.deleteQuery(id(value)));
  handle('pull', [1, 2], (value, pr) => service.pull(id(value), pr === undefined ? undefined : id(pr)));
  handle('review', [1], value => service.review(id(value)));
  handle('readFile', [4], (value, file, version, blob) => service.readFile(id(value), path(file), side(version), sha(blob)));
}
