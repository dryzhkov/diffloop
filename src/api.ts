export interface Connection {
  id: string;
  login: string;
  status: 'connected' | 'reauth_required' | 'error' | 'disconnected';
  lastPulledAt: string | null;
}

export interface SavedQuery { id: string; connectionId: string; query: string }
export interface AttentionReason {
  key: string;
  kind: 'direct_request' | 'team_request' | 'explicit_rerequest' | 'author_reply' | 'commits_after_changes_requested';
}
export interface TrackedPR { reasons: AttentionReason[]; snoozed: boolean; attentionReady: boolean; id: string; repository: string; number: number; state: string; title: string | null }

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
  reviews: Array<Comment & { state: string; commitSha?: string }>;
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
  agentState(pr: string, byConnection?: boolean): Promise<AgentState>;
  agentPolicy(pr: string, repository: boolean, policy: AgentPolicy | null, byConnection?: boolean): Promise<void>;
  agentMap(pr: string, remove: boolean): Promise<void>;
  agentConfig(pr: string, config: AgentConfig, byConnection?: boolean): Promise<AgentConfig>;
  agentDeleteConfig(pr: string, config: string, byConnection?: boolean): Promise<void>;
  agentStart(pr: string, config: string, scope: AgentScope, allowDrafts: boolean): Promise<string>;
  agentCancel(pr: string, run: string): Promise<void>;
  agentFinding(pr: string, run: string, finding: string, draft: boolean): Promise<void>;
  oauthAvailable(): Promise<boolean>;
  startOAuth(privateRepos: boolean): Promise<DeviceCode>;
  openOAuth(): Promise<void>;
  finishOAuth(): Promise<void>;
  cancelOAuth(): Promise<void>;
  connect(token: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  saveQuery(connectionId: string, query: string, id?: string): Promise<void>;
  deleteQuery(id: string): Promise<void>;
  openDraftUrl(id: string): Promise<void>;
  resolveDraft(id: string): Promise<void>;
  drafts(pr: string): Promise<Draft[]>;
  addDraft(pr: string, target: DraftTarget, head: string, body: string): Promise<void>;
  editDraft(id: string, body: string, included: boolean, general: boolean): Promise<void>;
  discardDraft(id: string): Promise<void>;
  pushDrafts(pr: string, ids: string[]): Promise<void>;
  checkDraft(id: string): Promise<void>;
  markHandled(id: string, keys: string[]): Promise<void>;
  snooze(id: string): Promise<void>;
  cancelPull(id: string): Promise<void>;
  pullProgress(id: string): Promise<string | null>;
  pull(connectionId: string, prId?: string): Promise<PullResult>;
  review(id: string): Promise<Review>;
  readFile(id: string, path: string, side: 'base' | 'head', blob: string): Promise<string>;
}

export interface CodeAnchor { path: string; side: 'base' | 'head'; startLine: number; endLine: number; commitSha: string }
export type DraftTarget = { kind: 'pr' } | { kind: 'inline'; anchor: CodeAnchor } |
  { kind: 'reply'; parent: string } | { kind: 'review'; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' } |
  { kind: 'thread'; thread: string; resolve: boolean };
export interface Draft {
  id: string; target: DraftTarget; head: string; body: string; included: boolean;
  agentRunId?: string | null; findingId?: string | null;
  status: 'local' | 'failed' | 'uncertain' | 'pushing' | 'pushed'; detail: string; url: string;
}

export const reviewContext = ['diff', 'changed_files', 'pr_description', 'review_threads'] as const;
export type ReviewContext = typeof reviewContext[number];
export interface AgentPolicy {
  enabled: boolean;
  context: ReviewContext[];
  allowDrafts: boolean;
}
export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  review: { kind: 'instructions' | 'skill' | 'plugin'; text: string };
  context: ReviewContext[];
  allowDrafts: boolean;
}
export type AgentScope = { kind: 'pr' } | { kind: 'selection'; anchor: CodeAnchor } | { kind: 'thread'; thread: string };
export interface AgentResource {
  key: string;
  kind: ReviewContext;
  revision: string;
  source: 'github';
}
export interface AgentFinding {
  id: string;
  title: string;
  evidence: string;
  explanation: string;
  anchor?: CodeAnchor;
  suggestedComment?: string;
  disposition: 'open' | 'dismissed' | 'converted_to_draft';
}
export interface AgentRun {
  id: string;
  config: AgentConfig;
  scope: AgentScope;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  base: string;
  head: string;
  diffBase: string | null;
  runtime: string;
  model: string;
  allowDrafts: boolean;
  grantedContext: ReviewContext[];
  started: string;
  finished?: string;
  error?: string;
  findings: AgentFinding[];
  manifest: Array<AgentResource & { hash: string; via: 'read' | 'search' }>;
  searches: Array<{ query: string; resources: string[]; truncated: boolean }>;
}
export interface AgentState {
  blocked: string | null;
  connection: AgentPolicy;
  repository: AgentPolicy | null;
  localRoot: string | null;
  configs: AgentConfig[];
  runs: AgentRun[];
}
