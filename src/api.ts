export interface Connection {
  id: string;
  login: string;
  status: 'connected' | 'reauth_required' | 'error' | 'disconnected';
  lastPulledAt: string | null;
}

export interface SavedQuery { id: string; connectionId: string; query: string }
export interface TrackedPR { id: string; repository: string; number: number; state: string; title: string | null }

export interface Metadata {
  title: string;
  body: string | null;
  author: string | null;
  repositoryId: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  updatedAt: string;
  baseSha: string;
  headSha: string;
}

export interface DiffFile {
  path: string;
  previousPath?: string;
  status: string;
  patch: string | null;
  patchError?: string;
}

export interface Diff {
  baseSha: string;
  headSha: string;
  diffBaseSha: string | null;
  files: DiffFile[];
}

export interface FileContent {
  path: string;
  side: 'base' | 'head';
  sha: string | null;
  blob?: string;
  error?: string;
}

export interface Comment {
  id: string;
  body: string | null;
  author: string | null;
  url: string;
  createdAt: string;
}

export interface Threads {
  comments: Comment[];
  reviews: Array<Comment & { state: string }>;
  threads: Array<{ id: string; path: string; line: number | null; diffSide?: 'LEFT' | 'RIGHT'; isResolved: boolean;
    isOutdated: boolean; comments: Array<Comment & { replyTo: { id: string } | null }> }>;
}

export interface Resource<T> {
  data: T | null;
  complete: boolean;
  cachedAt: string | null;
  revision: string | null;
  error: string | null;
}

export interface Review {
  metadata: Resource<Metadata>;
  diff: Resource<Diff>;
  files: Resource<FileContent[]>;
  comments: Resource<Threads['comments']>;
  reviews: Resource<Threads['reviews']>;
  threads: Resource<Threads['threads']>;
}

export interface WorkspaceStatus {
  accounts: number;
  credentialStorageAvailable: boolean;
  connections: Connection[];
  queries: SavedQuery[];
  pullRequests: Array<TrackedPR & { connectionId: string }>;
}

export interface PullResult { refreshed: number; errors: string[] }

export interface DeviceCode { userCode: string; expiresAt: number }

export interface WorkspaceApi {
  status(): Promise<WorkspaceStatus>;
  oauthAvailable(): Promise<boolean>;
  startOAuth(privateRepos: boolean): Promise<DeviceCode>;
  openOAuth(): Promise<void>;
  finishOAuth(): Promise<void>;
  cancelOAuth(): Promise<void>;
  connect(token: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  saveQuery(connectionId: string, query: string, id?: string): Promise<void>;
  deleteQuery(id: string): Promise<void>;
  pull(connectionId: string, prId?: string): Promise<PullResult>;
  review(id: string): Promise<Review>;
  readFile(id: string, path: string, side: 'base' | 'head', blob: string): Promise<string>;
}
