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

**Attention lifecycle:** opening a PR does not clear attention. Submitting a review clears only reasons included in the submission’s captured attention baseline; **Mark handled** acknowledges current reasons without publishing. New qualifying activity brings the PR back. Preserve activity arriving during review submission rather than clearing it accidentally.

Persist stable source event IDs and per-PR acknowledgement baselines. Repeated polls must not recreate handled requests. Reconcile current request state with request/removal events to distinguish re-requests; an incomplete sync must not clear reasons or advance baselines. On first sync, seed historical activity baselines and surface current outstanding requests rather than treating all past replies as new. Closed or merged PRs leave the active inbox while retaining local drafts and history.

**Snooze:** hide until new commits, a reply to your thread, or an explicit request. Metadata changes do not wake it.

Diffs use GitHub’s PR comparison semantics: record the merge-base SHA used for the displayed diff separately from the target branch tip. Pin fetched content to immutable SHAs, including fork heads; report unavailable revisions and incomplete, binary, or oversized patches explicitly. Never present a partial diff as complete. Offline review is limited to cached content.

## Agents

Start with subscription authentication through supported runtimes. Assume the tools are already installed; Diffloop detects them and checks compatibility. Users manage installation and updates. Missing or incompatible tools produce setup guidance, without blocking manual review:


| Connection     | Integration                    | Authentication     |
| -------------- | ------------------------------ | ------------------ |
| Codex          | Codex app server               | ChatGPT            |
| Claude Code    | Unmodified Claude Code runtime | Runtime's own flow |
| GitHub Copilot | Copilot SDK/CLI                | GitHub             |


Use supported sign-in flows; keep GitHub access separate from agent entitlement. Allow agent connections per GitHub connection, with stricter repository overrides; never switch automatically on failure or usage limits.

An **agent configuration** defines an agent connection/model, allowed context, and how to review: either direct instructions or a reference to a registered skill or plugin (for example, “Use the concurrency-review skill”). References resolve through the selected agent tool's registry. Diffloop checks availability before running and reports missing references; it does not maintain a registry, install extensions, or silently substitute instructions. It enforces context and tool permissions regardless of the instructions or referenced extension.

Run a configuration on a PR, diff selection, or thread. Users can cancel runs; v1 adds no Diffloop token or cost budgets and leaves usage limits to the agent tool. Each run snapshots the configuration, resolved skill/plugin identity and version when used, scope, base/head revisions, runtime/model, and supplied context.

V1 agents can only list, read, and search permitted revision-specific code and review context. Disable shell commands, file edits, publishing, and unselected extensions. Selected skills/plugins must obey the same limits; incompatible extensions cannot run. Verify each runtime can enforce this boundary before enabling its adapter. Broader permissions are deferred.

Context gathering follows the configuration’s instructions or selected skill/plugin. Do not automatically download a repository or explore related files. Instructions may direct the agent to local code or GitHub and request additional files when needed. Local code is optional; a checkout is not required. If the requested source or context is unavailable or ambiguous, surface that rather than silently choosing another source. Instructions guide behavior; configured permissions remain the access ceiling. Record the source and revision of context actually read, including local changes, and make search coverage explicit.

Context access goes through a Diffloop broker, scoped to the GitHub connection, repository, run, permitted context kinds, and explicitly allowed sources. Local roots require an explicit repository mapping; resolve paths and symlinks before access and reject escapes. A runtime's general read-only mode alone does not satisfy this policy. Disable ambient filesystem, network, inherited tools, and extension access that bypass the broker; provider transport and runtime authentication remain available. Treat PR text, code, and extension instructions as untrusted input, never as authority to widen permissions. If an adapter cannot enforce these restrictions, leave it unavailable.

Snapshot local content at read time, recording checkout commit, dirty state, and content hash; never label dirty content as an exact GitHub revision. Record search roots, filters, revision, and truncation as well as returned resources, so an empty result does not imply whole-repository coverage. Permission revocation stops affected runs and prevents further reads. Disconnecting a GitHub connection stops its sync and runs; retain drafts until explicit local deletion, with deletion covering caches and run context too.

## Drafts and publishing

Persist drafts across restarts. Flag findings and drafts affected by new commits. Before explicit user submission, recheck the PR revision and resolve invalid anchors. Track submission progress and reconcile uncertain network outcomes before retrying, avoiding duplicate reviews.

Submission freezes the included comments, action, body, head SHA, and attention baseline into a durable attempt before the first network mutation. Create and track a remote pending review, then submit it explicitly; handle pre-existing pending reviews without adopting or deleting them silently. Persist remote IDs at each stage. On timeout or restart, reconcile remote state against the frozen attempt before further writes. If reconciliation cannot identify an outcome uniquely, keep the attempt unresolved and require user resolution rather than retrying blindly. Only confirmed submission acknowledges its captured attention reasons. GitHub can change after the final revision check: submit against the reviewed commit and surface any subsequent change, without claiming an atomic check-and-submit guarantee.

Thread replies and resolving/unresolving threads are separate explicit operations, with durable operation records and the same uncertain-outcome handling. Revalidate inline anchors against the reviewed diff, including side, range, and renamed/deleted files. Let users edit, omit, or convert invalid inline comments into review-body text; never silently move an anchor. Findings and all drafts, including body-only reviews, become subject to recheck when their reviewed revisions change.

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
  diffBaseSha: string; // Merge base used by the displayed PR diff
  updatedAt: Timestamp; // GitHub timestamp
  lastSyncedAt: Timestamp;
}

// A durable watermark used by handling, snoozing, and submission snapshots.
interface AttentionBaseline {
  headSha: string;
  replyIds: string[];
  requestEventIds: string[];
}

// An evidenced reason to show a PR. Multiple reasons can coexist;
// explicit requests remain distinct from Diffloop-detected activity.
interface AttentionReason {
  id: ID;
  pullRequestId: ID;
  kind: "direct_request" | "team_request" | "explicit_rerequest"
    | "author_reply" | "commits_after_changes_requested";
  source: "github_request" | "diffloop_activity";
  evidence: { remoteId?: string; url?: string; headSha?: string; eventKey: string };
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
  allowedSources: Array<
    { kind: "github" }
    | { kind: "local"; repositoryId: string; rootId: ID }
  >; // Root IDs resolve to explicitly granted local mappings.
  allowedContext: Array<"diff" | "changed_files" | "repository_files"
    | "pr_description" | "review_threads">;
}

// Identifies code against an exact revision, including multiline selections.
interface CodeAnchor {
  commitSha: string;
  path: string;
  side: "base" | "head"; // Base-side commitSha is diffBaseSha, not target tip.
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
  diffBaseSha: string;
  runtimeVersion: string;
  resolvedModel: string;
  searchCoverage: Array<{
    source: string;
    root: string;
    revision?: string;
    query: string;
    filters: string[];
    truncated: boolean;
  }>;
  contextManifest: Array<{
    resource: string;
    contentHash: string;
    commitSha?: string;
    source: "github" | "local" | "review_context";
    localRootId?: ID;
    dirty?: boolean;
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
  reviewedBaseSha: string;
  reviewedHeadSha: string;
  revisionStatus: "current" | "needs_recheck";
  action: "comment" | "approve" | "request_changes";
  status: "editing" | "submitting" | "outcome_unknown" | "submitted";
  submission?: {
    attemptId: ID;
    headSha: string;
    payloadHash: string;
    frozenPayloadRef: ID; // Immutable body/action/comments, not mutable draft rows
    attentionBaseline: AttentionBaseline;
    stage: "creating" | "pending" | "submitting" | "confirmed";
    // Append-only attempt history is retained separately from this active attempt.
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

The interfaces above describe domain records, not the full database schema. Persist acknowledgement baselines, local root grants, immutable submission payloads/attempt history, and thread operation records separately. Use connection-scoped uniqueness for remote objects and event keys, foreign keys, migrations, and transactions for attention changes and submission state. Record per-resource sync completeness/errors; a successful partial fetch is not a complete PR snapshot.

## Implementation tasks

1. Validate GitHub API flows and each runtime’s authentication, extension support, and permission enforcement before enabling adapters.
2. Bootstrap Electron/React, validated preload APIs, SQLite migrations, and credential storage.
3. Add GitHub authentication, team discovery, resilient sync, and revision-specific caching with offline reads.
4. Build virtualized diffs, selections, threads, and comment anchors; handle large and incomplete patches.
5. Implement inbox reasons, activity baselines, Mark handled, and snooze wake-ups.
6. Add durable drafts, revision checks, explicit review/thread publishing, and recovery without duplicate submissions.
7. Build agent connections, repository grants, local mappings, and a restricted context broker.
8. Add agent configurations, scoped runs, cancellation, findings, draft conversion, and history.
9. Test attention transitions, account isolation, agent restrictions, stale revisions, and crash/network recovery.
10. Sign, notarize, and verify macOS releases; publish a Homebrew cask. Assess Windows separately.

## Contract references

Use these as starting points for task 1; supported versions and observed capabilities belong in its validation record:

- [GitHub OAuth device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- [GitHub pull request reviews](https://docs.github.com/en/rest/pulls/reviews) — pending reviews, commit targeting, and submission.
- [GitHub review threads](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread) — thread identity and resolution state.
