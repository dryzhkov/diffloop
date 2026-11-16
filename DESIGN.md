# Diffloop — engineering design

Initial design · macOS first · Windows later

## Product

A local desktop app for reviewing other people's GitHub PRs. It answers:

- **What needs my attention?** A personal inbox with clear reasons for each PR.
- **What should I verify?** Read-only agents that turn focused checks into findings and editable draft comments.

V1 includes diffs, threads, and review submission without a local clone. Users decide what to publish. No Diffloop account or backend; state stays on the machine. GitHub and selected agent providers receive the context needed for their operations.

## Architecture

**Electron + React + TypeScript/Node.js + SQLite.** Most work is network I/O and UI rendering; no Rust in v1.


| Layer               | Responsibility                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| React renderer      | Inbox, virtualized diffs, threads, agent configurations, findings, drafts          |
| TypeScript core     | GitHub sync, attention rules, context permissions, agent orchestration, publishing |
| SQLite              | Cached PRs, inbox state, agent configurations, runs, findings, drafts              |
| Local files         | Revision-specific code caches                                                      |
| OS credential store | Diffloop-managed tokens; agent runtimes manage their own credentials               |


Use a sandboxed renderer with no Node access and a narrow, validated preload API. Keep business logic independent of Electron and expensive processing off the main thread.

## Release Target

A signed macOS app and Homebrew cask. Keep Windows feasible as a follow up.

## GitHub and inbox

V1 targets individual reviewers on GitHub.com, including accessible organization repositories and team review requests. Discover the connected user’s accessible team memberships to surface those requests. GitHub Enterprise Server is deferred. Scope credentials, identities, and caches by connection.

- **GitHub.com:** OAuth device flow in the system browser, without a backend or embedded secret. Request `repo` and `read:org`; explain their breadth.
- **Sync:** poll while running, refresh on focus, and allow manual refresh. Handle pagination, rate limits, and partial failures. Cached content works offline.

GitHub owns published PR/review state. Diffloop owns attention state, snoozes, agent configurations, runs, and drafts.

Show one inbox item per PR with all applicable reasons: direct request, team request, explicit re-request, author reply to your thread, or new commits since you requested changes. 

**Attention lifecycle:** opening a PR does not clear attention. Submitting a review clears the reasons addressed by that review; **Mark handled** acknowledges current reasons without publishing. New qualifying activity brings the PR back. Preserve activity arriving during review submission rather than clearing it accidentally.

**Snooze:** hide until new commits, a reply to your thread, or an explicit request. Metadata changes do not wake it.

## Agents

Start with subscription authentication through supported runtimes. Assume the tools are already installed; Diffloop detects them and checks compatibility. Users manage installation and updates. Missing or incompatible tools produce setup guidance, without blocking manual review:


| Connection     | Integration                    | Authentication     |
| -------------- | ------------------------------ | ------------------ |
| Codex          | Codex app server               | ChatGPT            |
| Claude Code    | Unmodified Claude Code runtime | Runtime's own flow |
| GitHub Copilot | Copilot SDK/CLI                | GitHub             |


Use supported sign-in flows; Keep GitHub access separate from agent entitlement. Allow agent connections per GitHub connection, with stricter repository overrides; never switch automatically on failure or usage limits. 

An **agent configuration** defines an agent connection/model, allowed context, and how to review: either direct instructions or a reference to a registered skill or plugin (for example, “Use the concurrency-review skill”). References resolve through the selected agent tool's registry. Diffloop checks availability before running and reports missing references; it does not maintain a registry, install extensions, or silently substitute instructions. It enforces context and tool permissions regardless of the instructions or referenced extension.

Run a configuration on a PR, diff selection, or thread. Users can cancel runs; v1 adds no Diffloop token or cost budgets and leaves usage limits to the agent tool. Each run snapshots the configuration, resolved skill/plugin identity and version when used, scope, base/head revisions, runtime/model, and supplied context.

V1 agents can only list, read, and search permitted revision-specific code and review context. Disable shell commands, file edits, publishing, and unselected extensions. Selected skills/plugins must obey the same limits; incompatible extensions cannot run. Verify each runtime can enforce this boundary before enabling its adapter. Broader permissions are deferred.

Context gathering follows the configuration’s instructions or selected skill/plugin. Do not automatically download a repository or explore related files. Instructions may direct the agent to local code or GitHub and request additional files when needed. Local code is optional; a checkout is not required. If the requested source or context is unavailable or ambiguous, surface that rather than silently choosing another source. Instructions guide behavior; configured permissions remain the access ceiling. Record the source and revision of context actually read, including local changes, and make search coverage explicit. 

## Drafts and publishing

Persist drafts across restarts. Flag findings and drafts affected by new commits. Before explicit user submission, recheck the PR revision and resolve invalid anchors. Track submission progress and reconcile uncertain network outcomes before retrying, avoiding duplicate reviews.

## Core Data Models

```ts
type ID = string;
type Timestamp = string;

// A GitHub.com account. Keeps authentication and sync isolated.
interface Connection {
  id: ID;
  host: "github.com";
  accountId: string;
  login: string;
  credentialRef: string; // OS credential-store reference
  status: "connected" | "reauth_required" | "error";
  lastSyncedAt?: Timestamp;
}

// A signed-in agent runtime, separate from GitHub repository access.
// Explicit grants prevent personal/work context from crossing connections.
interface AgentConnection {
  id: ID;
  runtime: "codex" | "claude" | "copilot";
  runtimeAccountRef: string; // Runtime-managed identity, not a token
  status: "connected" | "reauth_required" | "unavailable";
  access: Array<{
    connectionId: ID;
    repositoryIds: string[] | "all"; // Remote repository IDs
  }>;
}

// A cached PR snapshot. Supports offline reading and revision-aware reviews.
interface PullRequest {
  id: ID;
  connectionId: ID;
  repositoryId: string;
  repositoryName: string; // owner/repo
  remoteId: string;
  number: number;
  url: string;
  title: string;
  author: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  baseSha: string;
  headSha: string;
  updatedAt: Timestamp; // GitHub timestamp
  lastSyncedAt: Timestamp;
}

// An evidenced reason to show a PR. Multiple reasons can coexist;
// explicit requests remain distinct from Diffloop-detected activity.
interface AttentionReason {
  id: ID;
  pullRequestId: ID;
  kind: "direct_request" | "team_request" | "explicit_rerequest"
    | "author_reply" | "commits_after_changes_requested";
  source: "github_request" | "diffloop_activity";
  evidence: { remoteId?: string; url?: string; headSha?: string };
  observedAt: Timestamp;
  acknowledgedAt?: Timestamp;
  clearedAt?: Timestamp;
}

// Hides a PR until qualifying activity differs from this baseline.
// Stable event IDs, rather than timestamps alone, support wake-up checks.
interface Snooze {
  pullRequestId: ID;
  createdAt: Timestamp;
  baselineHeadSha: string;
  baselineReplyIds: string[];
  baselineRequestEventIds: string[];
}

// A reusable review setup: direct instructions OR a registered extension,
// plus execution settings and context permissions enforced by Diffloop.
interface ReviewAgentConfig {
  id: ID;
  name: string;
  agentConnectionId: ID;
  model: string;
  review: { kind: "instructions"; text: string }
    | { kind: "skill" | "plugin"; registeredName: string };
  allowedContext: Array<"diff" | "changed_files" | "repository_files"
    | "pr_description" | "review_threads">;
}

// Identifies code against an exact revision, including multiline selections.
interface CodeAnchor {
  commitSha: string;
  path: string;
  side: "base" | "head";
  startLine: number;
  endLine: number;
}

// An execution record. Snapshots preserve what was reviewed even if the
// configuration changes; the manifest records what the agent actually read.
interface AgentRun {
  id: ID;
  pullRequestId: ID;
  configSnapshot: ReviewAgentConfig;
  resolvedExtension?: { name: string; version?: string; contentHash?: string };
  scope: { kind: "pr" }
    | { kind: "selection"; anchors: CodeAnchor[] }
    | { kind: "thread"; remoteThreadId: string };
  baseSha: string;
  headSha: string;
  runtimeVersion: string;
  contextManifest: Array<{
    resource: string;
    contentHash: string;
    commitSha?: string;
  }>;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: Timestamp;
  finishedAt?: Timestamp;
  error?: string;
}

// An agent's claim and evidence, kept separate from user-authored drafts.
interface Finding {
  id: ID;
  runId: ID;
  title: string;
  explanation: string;
  evidence: string;
  anchor?: CodeAnchor;
  suggestedComment?: string;
  disposition: "open" | "dismissed" | "converted_to_draft";
  anchorStatus: "current" | "needs_recheck";
}

// A durable review awaiting user submission. Records uncertain outcomes
// so a network failure does not cause blind retries and duplicate reviews.
interface DraftReview {
  id: ID;
  pullRequestId: ID;
  body: string;
  action: "comment" | "approve" | "request_changes";
  status: "editing" | "submitting" | "outcome_unknown" | "submitted";
  submission?: {
    attemptId: ID;
    headSha: string;
    payloadHash: string;
    startedAt: Timestamp;
    remoteReviewId?: string;
  };
  updatedAt: Timestamp;
}

// An editable inline comment, optionally derived from a finding.
// Selection and anchor validation determine whether it can be published.
interface DraftComment {
  id: ID;
  draftReviewId: ID;
  findingId?: ID;
  body: string;
  anchor: CodeAnchor;
  anchorStatus: "valid" | "needs_recheck" | "invalid";
  included: boolean;
  remoteCommentId?: string;
  updatedAt: Timestamp;
}
```

## Implementation tasks

1. Bootstrap Electron/React, preload boundary, SQLite, and credential storage.
2. Validate large diffs, selection, threads, and comment anchors in a prototype.
3. Add GitHub authentication, synchronization, and revision-specific code caching.
4. Build inbox reasons, acknowledgements, and snoozing.
5. Add durable drafts and explicit review submission with revision/retry checks.
6. Add runtime connections, agent configurations, restricted tools, findings, and run history.
7. Test state transitions, account isolation, agent restrictions, and recovery.
8. Package macOS releases and Homebrew distribution; assess Windows separately.