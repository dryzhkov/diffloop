// Read-only integration probe. Only the fixed GraphQL query uses POST.
const target = process.argv[2]?.match(/^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/);
const token = process.env.DIFFLOOP_GITHUB_PAT;
if (!target || !token) {
  console.error('Set DIFFLOOP_GITHUB_PAT and pass "owner/repo#number".');
  process.exit(2);
}
const [, owner, repo, number] = target;
const root = `/repos/${owner}/${repo}`;
const pr = `${root}/pulls/${number}`;
const query = `query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    reviewThreads(first:1) { nodes { id isResolved viewerCanResolve } }
  } }
}`;
const checks = [
  ['identity', '/user', data => Number.isInteger(data.id)],
  ['pull request', pr, data => Boolean(data.base?.sha && data.head?.sha)],
  ['general comments', `${root}/issues/${number}/comments?per_page=1`, Array.isArray],
  ['inline comments', `${pr}/comments?per_page=1`, Array.isArray],
  ['reviews', `${pr}/reviews?per_page=1`, Array.isArray],
  ['review threads', '/graphql', data => !data.errors &&
    Array.isArray(data.data?.repository?.pullRequest?.reviewThreads?.nodes)],
];
for (const [label, path, validate] of checks) {
  try {
    const response = await fetch(new URL(path, 'https://api.github.com'), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      ...(path === '/graphql' && { method: 'POST', body: JSON.stringify({
        query, variables: { owner, repo, number: Number(number) },
      }) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!validate(await response.json())) throw new Error('unexpected response shape or API error');
    console.log('PASS', label);
  } catch (error) {
    console.error('FAIL', label, error.message);
    process.exitCode = 1;
  }
}
