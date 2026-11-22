# Diffloop Engineering Design

## Product

A local desktop app for reviewing other people's GitHub PRs. It answers:

- **What needs my attention?** A personal inbox with clear reasons for each PR.
- **What should I verify?** Agents that review code and, when asked, create editable local draft comments.
- **What is important for me to review?** Ability to have agents review PRs first and together with engineer is the loop.

V1 includes:

- Offline-first diffs, threads, and local drafts without a local clone.
- Explicit **Pull** to download review context and **Push** to publish selected local work.
- Users decide what to publish.
- No Diffloop account or backend; state stays on the machine.
- Users can connect to GitHub using Personal Access Tokens (PATs)

## Architecture

**The core:** Electron + React + TypeScript/Node.js + SQLite


| Layer               | Responsibility                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| React renderer      | Inbox, virtualized diffs, threads, agent configurations, findings, drafts          |
| TypeScript core     | GitHub Pull/Push, attention rules, context permissions, agent orchestration, publishing |
| SQLite              | Cached PRs, inbox state, agent configurations, review runs, findings, drafts       |
| Local files         | Revision-specific code caches                                                      |
| OS credential store | Diffloop-managed tokens; agent runtimes manage their own credentials.              |


Key concepts for implementation:

- Use a sandboxed renderer with no Node access and a narrow, validated preload API.
- Keep business logic independent of Electron and expensive processing off the main thread.
- OS credential store needs provides an abstraction for MacOS vs Windows
- Should try to isolate and abstract OS specific parts as much as possible to make adding new OS easier

## Release Target

V1 - A signed macOS app and Homebrew cask. Post V1 - add Windows

## GitHub and inbox

V1 targets individual reviewers on GitHub.com, including accessible organization repositories and team review requests. Let user provide GitHub queries to fetch PRs to review, auto-discovery is not needed to start with. GitHub Enterprise Server is deferred.

- **GitHub.com:** Use PATs and let user provide GitHub queries to get list of PRs they are interested in.
- **Pull:** user-initiated discovery of PRs through saved queries. After discovery, track each PR by its connection-scoped GitHub ID. On every Pull, refresh tracked open PRs and their review context even if the query changes, is deleted, or stops matching. Handle pagination, rate limits, and partial failures. No periodic, launch, or focus-triggered sync in V1.
- **Offline:** after Pull, cached PR metadata, diffs, changed-file content, and threads remain available across restarts. Users can review, manage attention, and create/edit drafts without a connection. Show last-pulled time and missing content explicitly; uncached context requires an explicit fetch. Pull preserves all local drafts.
- **Push:** only an explicit user action publishes selected drafts. Send comments individually, show each result, and allow per-comment retry; one failure does not block the remaining comments. Offline Push leaves drafts local for the user to push later; reconnecting never publishes automatically.

GitHub owns published PR/review state. Diffloop owns attention state, snoozes, agent configurations, runs, and drafts.

Show one inbox item per PR with all applicable reasons: direct request, team request, explicit re-request, author reply to your thread, or new commits since you requested changes.

**Attention lifecycle:** opening a PR does not clear attention. A confirmed review action clears only reasons included in its captured attention baseline; pushing individual comments does not mark a PR handled; **Mark handled** acknowledges current reasons without publishing. New qualifying activity brings the PR back. Preserve activity arriving during Push rather than clearing it accidentally.

Persist stable source event IDs and per-PR acknowledgement baselines. Repeated pulls must not recreate handled requests. Reconcile current request state with request/removal events to distinguish re-requests; an incomplete Pull must not clear reasons or advance baselines. On first Pull, seed historical activity baselines and surface current outstanding requests rather than treating all past replies as new. Closed or merged PRs leave the active inbox while retaining local drafts and history.

**Snooze:** hide until a Pull discovers new commits, a reply to your thread, or an explicit request. Metadata changes do not wake it.

Diffs use GitHub’s PR comparison semantics: record the merge-base SHA used for the displayed diff separately from the target branch tip. Pin fetched content to immutable SHAs, including fork heads; report unavailable revisions and incomplete, binary, or oversized patches explicitly. Never present a partial diff as complete. Offline review is limited to cached content.

## Agents

Start with subscription authentication through supported runtimes. Assume the tools are already installed; Diffloop detects them and checks compatibility. Users manage installation and updates. Missing or incompatible tools produce setup guidance, without blocking manual review:


| Connection     | Integration                    | Authentication     |
| -------------- | ------------------------------ | ------------------ |
| Codex          | Codex app server               | ChatGPT            |
| Claude Code    | Unmodified Claude Code runtime | Runtime's own flow |
| GitHub Copilot | Copilot SDK/CLI                | GitHub             |


Use supported sign-in flows; keep GitHub access separate from agent entitlement. Allow agent connections per GitHub connection, with stricter repository overrides; keep the chosen runtime fixed for the session, including on failure or usage limits.

An **agent configuration** defines an agent connection/model, allowed context, and how to review: either direct instructions or a reference to a registered skill or plugin (for example, “Use the concurrency-review skill”). References resolve through the selected agent tool's registry. Diffloop checks availability before running and reports missing references; it does not maintain a registry, install extensions, or silently substitute instructions. It enforces context and tool permissions regardless of the instructions or referenced extension.

Run a configuration on a PR, diff selection, or thread. Users can cancel runs; v1 adds no Diffloop token or cost budgets and leaves usage limits to the agent tool. Each run snapshots the configuration, resolved skill/plugin identity and version when used, scope, base/head revisions, runtime/model, and supplied context.

V1 agents can list, read, and search permitted code and review context. When explicitly asked, they can create local draft comments through a narrow Diffloop tool. They cannot publish, trigger Push, or modify existing user drafts. Disable shell commands, source-file edits, remote writes, and unselected extensions. Selected skills/plugins must obey the same limits; incompatible extensions cannot run. Verify each runtime can enforce this boundary before enabling its adapter. Broader permissions are deferred.

Cloud agent runtimes still require connectivity to their provider; offline manual review and drafting do not. Agents can use cached GitHub context without a new Pull, but uncached GitHub reads require an explicit user fetch and never trigger background synchronization.

Context gathering follows the configuration’s instructions or selected skill/plugin. Do not automatically download a repository or explore related files. Instructions may direct the agent to local code or GitHub and request additional files when needed. Local code is optional; a checkout is not required. If the requested source or context is unavailable or ambiguous, surface that rather than silently choosing another source. Instructions guide behavior; configured permissions remain the access ceiling. Record the source and revision of context actually read, including local changes, and make search coverage explicit.

Snapshot local content at read time, recording checkout commit, dirty state, and content hash; never label dirty content as an exact GitHub revision. Record search roots, filters, revision, and truncation as well as returned resources, so an empty result does not imply whole-repository coverage. Permission revocation stops affected runs and prevents further reads. Disconnecting a GitHub connection stops its remote operations and runs; retain drafts until explicit local deletion, with deletion covering caches and run context too.

## Drafts and publishing

- **Local first:** persist every draft across restarts, including agent-created comments with run provenance. Users can edit, select, or discard local drafts before Push. Pull never overwrites them.
- **Independent pushes:** snapshot selected comments when the user clicks Push, then send one comment at a time. Persist each attempt and remote ID. Continue after a failure; show pushed, failed, and uncertain results per comment. Retry only the selected failed comments, never successful ones. Edits made during Push remain local and are not included in that attempt. Once a comment is confirmed published, further changes are handled on GitHub; retain any newer local text for the user to copy there.
- **Simple conflicts:** before sending, check the remote revision and inline anchor. Flag stale or invalid comments individually; let the user edit, skip, or move the text to a general PR comment. Do not automatically merge drafts or move anchors. Link to GitHub for anything the user prefers to resolve there.
- **Uncertain outcomes:** after a timeout or crash, check whether that comment was published before retrying. If the outcome remains ambiguous, show it as uncertain with a GitHub link; the user resolves it before another attempt. Other comments can proceed.
- **Review actions:** approval, request changes, and review-body submission are separate explicit user operations with their own result and retry state. Do not automatically submit a review action after a partially successful comment batch. Approve the pulled head SHA the user reviewed. At Push, notify the user if the remote head has advanced and identify which SHA the approval covers. Bind the submission to the reviewed SHA even if the head changes during submission. Only a confirmed review action acknowledges its captured attention baseline.
- **Threads:** replies use the same per-comment Push flow; resolving/unresolving a thread is a separate explicit user operation. All remote mutations remain unavailable to agents.

Published comments retain their local record and remote link. Editing or deleting already-published content in Diffloop is deferred; users can do that on GitHub. New commits flag affected findings and drafts for recheck without discarding local text.

## Core Data Models

```ts
type ID = string;
type Timestamp = string;

// A GitHub.com account. Keeps authentication and Pull/Push isolated.
interface Connection {
  id: ID;
  host: "github.com";
  accountId: string;
  login: string;
  credentialRef: string; // OS credential-store reference
  status: "connected" | "reauth_required" | "error";
  lastPulledAt?: Timestamp;
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
  lastPulledAt: Timestamp;
}

// A durable watermark used by handling, snoozing, and review-action snapshots.
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
  allowLocalDraftCreation: boolean; // Also requires an explicit user request for the run.
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

// A local review workspace. Comments are pushed independently of its action.
interface DraftReview {
  id: ID;
  pullRequestId: ID;
  body: string;
  reviewedBaseSha: string;
  reviewedHeadSha: string;
  revisionStatus: "current" | "needs_recheck";
  action: "comment" | "approve" | "request_changes";
  actionStatus: PushStatus;
  remoteReviewId?: string;
  updatedAt: Timestamp;
}

type PushStatus = "local" | "pushing" | "pushed" | "failed" | "outcome_unknown";

// A durable comment, created by the user or an explicitly instructed agent.
interface DraftComment {
  id: ID;
  draftReviewId: ID;
  findingId?: ID;
  createdBy: { kind: "user" } | { kind: "agent"; runId: ID };
  body: string;
  target: { kind: "inline"; anchor: CodeAnchor }
    | { kind: "pr" }
    | { kind: "reply"; remoteCommentId: string };
  anchorStatus: "valid" | "needs_recheck" | "invalid" | "not_applicable";
  included: boolean;
  pushStatus: PushStatus;
  remoteCommentId?: string;
  remoteUrl?: string;
  lastError?: string;
  updatedAt: Timestamp;
}

// One immutable attempt per comment or separate review/thread action.
interface PushAttempt {
  id: ID;
  target: { kind: "comment"; draftCommentId: ID }
    | { kind: "review_action"; draftReviewId: ID }
    | { kind: "thread_state"; pullRequestId: ID; remoteThreadId: string };
  frozenPayloadRef: ID;
  payloadHash: string;
  headSha: string;
  attentionBaseline?: AttentionBaseline; // Review actions only
  status: "pushing" | "pushed" | "failed" | "outcome_unknown";
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  remoteId?: string;
  error?: string;
}

```

The interfaces above describe domain records, not the full database schema. Persist acknowledgement baselines, local root grants, immutable per-item Push payloads/attempt history, and thread operation records separately. Use connection-scoped uniqueness for remote objects and event keys, foreign keys, migrations, and transactions for attention changes and Push state. Record per-resource Pull completeness/errors; a successful partial fetch is not a complete PR snapshot.

## Implementation tasks

1. **Partially validated.** GitHub reads and Codex session setup were exercised. Fine-grained PAT permissions, live GitHub writes, and runtime extension and permission enforcement checks remain open. See [stage-one observations](docs/stage-one.md).
2. **Implemented.** Bootstrap Electron/React, validated preload APIs, SQLite migrations, and credential storage.
3. **Implemented.** Add PAT connections, saved PR queries, explicit Pull, and persistent offline review caches.
4. **Implemented.** Build virtualized diffs, selections, threads, and comment anchors; show missing or incomplete context.
5. **Implemented.** Implement inbox reasons, activity baselines, Mark handled, and Pull-driven snooze wake-ups.
6. **Implemented.** Add local drafts, per-comment Push/retry, simple conflict handling, and separate review/thread actions. Live publishing validation remains part of stage 1.
7. **Partially implemented.** Diffloop runs Codex in a temporary profile with restricted review tools. Connection and repository grants apply to cached GitHub context and local drafts. Local folder mappings exist, with checkout access still open.
8. **Implemented for direct Codex instructions.** Added Codex configurations, PR, selection, and thread scopes, cancellation, persisted findings and run history, and local drafts with run provenance. Registered skill and plugin resolution remains open.
9. **Partially covered.** Fixtures exercise offline/restart workflows, partial Push failures, and uncertain-outcome recovery. Agent fixtures cover scope isolation, revocation during a read, draft consent, and the absence of publishing tools. Repeat the capability checks with a live adapter before enabling it.
10. **Pending.** Sign, notarize, and verify macOS releases; publish a Homebrew cask. Assess Windows separately.

## Contract references

Validate API behavior and runtime capabilities in task 1:

- [GitHub PAT authentication](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [GitHub PR review comments](https://docs.github.com/en/rest/pulls/comments) — individual inline comments and replies.
- [GitHub issue comments](https://docs.github.com/en/rest/issues/comments) — general PR comments.
- [GitHub pull request reviews](https://docs.github.com/en/rest/pulls/reviews) — separate review actions.
- [GitHub review threads](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread) — thread identity and resolution state.
