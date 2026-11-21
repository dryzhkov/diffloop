# GitHub OAuth in Diffloop

Register a GitHub.com OAuth App in GitHub's developer settings and enable **Device Flow** in its settings. Copy the public **Client ID** and give it to Diffloop at launch.

```sh
DIFFLOOP_GITHUB_OAUTH_CLIENT_ID=your_client_id npm start
```

Select **Sign in with GitHub**, open the verification page from Diffloop, and enter the code displayed in Diffloop. Confirm the OAuth app name on GitHub before authorizing. Diffloop stores the resulting token in the same OS-backed credential store as a PAT. Signing in to the same GitHub account preserves its queries and cached PRs.

The default sign-in requests public access. **Request private repository access** requests GitHub's broad `repo` OAuth scope. For more narrowly scoped private access, connect with a fine-grained PAT.

See [GitHub's OAuth device flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow).
