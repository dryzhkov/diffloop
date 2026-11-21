# Stage one observations

Run the read probe with Node 22+ and a GitHub.com PAT supplied through the environment.

```sh
node scripts/probe-github.mjs 'owner/repo#123'
```

Set `DIFFLOOP_GITHUB_PAT` through your credential manager. The probe checks one page per resource, prints one result per check, and exits nonzero on failure. Empty collections are valid.

All six reads passed on nodejs/node#67666 using the existing GitHub CLI credential. This covers the REST identity, PR, general comments, inline comments and reviews endpoints, plus GraphQL thread access. Fine-grained PAT permissions and private organization access still need a dedicated test account.

## Publishing contracts to exercise on a disposable PR

| Operation | Request | Evidence to capture |
| --- | --- | --- |
| General comment | POST /repos/{owner}/{repo}/issues/{number}/comments with body | Returned comment ID and URL |
| Inline comment | POST /repos/{owner}/{repo}/pulls/{number}/comments with body, reviewed commit_id, path, side and line | Returned anchor, ID and URL. For multiline selections include start_line and start_side |
| Reply | POST /repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies with body | Parent ID on returned reply to a top-level inline comment |
| Review | POST /repos/{owner}/{repo}/pulls/{number}/reviews with event and reviewed commit_id | Returned state and commit_id after head advances. Use another author's PR for approval or change requests |
| Thread state | GraphQL resolveReviewThread or unresolveReviewThread with threadId | Re-read thread ID and isResolved after each operation |

Use a fine-grained PAT scoped to the fixture repository with Pull requests write permission. Repeat read and write cases with a read-only PAT and record denials. Live mutations remain untested.

Sources include [issue comments](https://docs.github.com/en/rest/issues/comments), [review comments](https://docs.github.com/en/rest/pulls/comments), [reviews](https://docs.github.com/en/rest/pulls/reviews) and [GraphQL mutations](https://docs.github.com/en/graphql/reference/mutations).

## Runtime observations

| Runtime | Locally observed | Still to verify |
| --- | --- | --- |
| Codex 0.171.0 | CLI reports ChatGPT login. Generated app-server schema exposes account/read, skills/list, plugin/list and thread/start | Live extension resolution and effective session tool restrictions |
| Claude Code 2.1.330 | Signed out. CLI exposes built-in tool selection, strict MCP configuration, plugin directories and skill disabling | Subscription session, selective extension loading and effective restrictions |
| Copilot CLI 1.0.114 | CLI exposes skill and plugin management, available-tools and disable-builtin-mcps | Runtime identity, entitlement and effective SDK/CLI restrictions |

Before enabling an adapter, run an isolated fixture with one permitted context resource and one ungranted resource. Record the actual tools exposed, context returned, and attempted operations. Verify that reading the permitted resource succeeds, while shell, ungranted reads, file edits, publishing and unselected extensions are unavailable. Repeat with a selected extension. Verify that local draft creation requires both configuration permission and an explicit run request, and that revoking a grant stops subsequent reads. CLI flags and protocol schemas alone leave these checks open.

### Codex app-server probe

Run `node scripts/probe-codex.mjs` with Codex on PATH. On 0.171.0 the live stdio handshake, ChatGPT account check, skill listing, local plugin marketplace listing and ephemeral thread creation passed. The server returned a read-only sandbox and disabled approval prompts. The probe uses an empty temporary directory and submits no model turn. These observations cover session setup. Shell exclusion, scoped reads, selected-extension isolation and draft permission enforcement still require validation before enabling reviews.

PAT-specific tests and the Claude Code and Copilot probes are deferred while development focuses on Codex.
