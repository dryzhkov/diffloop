import type { Comment, Threads } from './api';

const origin = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class GitHub {
  private stop?: GitHubError;
  get stopped() { return this.stop !== undefined; }
  get authenticationFailed() { return this.stop?.status === 401; }

  constructor(private readonly token: string, private readonly request = fetch, private readonly cancellation?: AbortSignal) {}

  async get<T>(path: string, graph?: { query: string; variables: object }) {
    if (this.cancellation?.aborted) throw new Error('Pull cancelled');
    if (this.stop) throw this.stop;
    const url = new URL(path, origin);
    if (url.origin !== origin || url.username || url.password) throw new Error('Invalid GitHub API URL');
    const timeout = AbortSignal.timeout(20000);
    const signal = this.cancellation ? AbortSignal.any([timeout, this.cancellation]) : timeout;
    let response: Response;
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'manual', signal,
        ...(graph && { method: 'POST', body: JSON.stringify(graph) }),
      });
    } catch {
      if (this.cancellation?.aborted) throw new Error('Pull cancelled');
      this.stop = new GitHubError('GitHub could not be reached or the request timed out', 0);
      throw this.stop;
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const reset = response.headers.get('x-ratelimit-reset');
      const limited = response.status === 429 || (response.status === 403 &&
        (retry !== null || response.headers.get('x-ratelimit-remaining') === '0' ||
          /rate limit/i.test(await response.text())));
      const retryAt = retry && /^\d+$/.test(retry) ? ` Retry in ${retry} seconds.` :
        reset && /^\d{1,12}$/.test(reset) ? ` Retry after ${new Date(Number(reset) * 1000).toLocaleString()}.` : '';
      const error = new GitHubError(limited ? `GitHub rate limit reached.${retryAt}` : `GitHub returned HTTP ${response.status}`,
        limited ? 429 : response.status);
      if (limited || response.status === 401) this.stop = error;
      throw error;
    }
    const data: T = await response.json().catch(() => { throw new Error('Invalid GitHub response'); });
    const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    return { data, next };
  }

  async *pages<T>(path: string, select: (data: unknown) => T[]) {
    const visited = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      if (visited.has(next)) throw new Error('GitHub repeated a pagination link');
      visited.add(next);
      const page: { data: unknown; next?: string } = await this.get(next);
      const items = select(page.data);
      if (!Array.isArray(items)) throw new Error('Invalid GitHub page');
      yield* items;
      next = page.next;
    }
  }

  async graphPages<T>(query: string, variables: object, select: (data: GraphData) => GraphPage<T> | undefined) {
    const nodes: T[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const { data }: { data: GraphEnvelope } = await this.get<GraphEnvelope>('/graphql',
        { query, variables: { ...variables, cursor } });
      if (data.errors?.some(error => error.type === 'RATE_LIMITED')) {
        this.stop = new GitHubError('GitHub GraphQL rate limit reached', 429);
        throw this.stop;
      }
      const page: GraphPage<T> | undefined = data.data && select(data.data);
      if (data.errors?.length || !Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== 'boolean') {
        throw new Error('GitHub GraphQL data is unavailable or incomplete');
      }
      for (const node of page.nodes) {
        const id = (node as { id?: string } | null)?.id;
        if (!id || ids.has(id)) throw new Error('Invalid or duplicate GitHub GraphQL node');
        nodes.push(node);
        ids.add(id);
      }
      if (!page.pageInfo.hasNextPage) {
        if (nodes.length !== page.totalCount) throw new Error('GitHub GraphQL results changed during pagination');
        return nodes;
      }
      cursor = page.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) throw new Error('Invalid GitHub GraphQL cursor');
      cursors.add(cursor);
    } while (cursor);
    return nodes;
  }
}

type Thread = Threads['threads'][number];
type GraphComment = Omit<Thread['comments'][number], 'author'> & { author: { login: string } | null };
interface GraphPage<T> { nodes: T[]; totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean } }
interface GraphEnvelope { data?: GraphData; errors?: Array<{ type?: string }> }
interface GraphData {
  node?: { reviewThreads?: GraphPage<Omit<Thread, 'comments'>>; comments?: GraphPage<GraphComment> };
}
const pageFields = 'totalCount pageInfo { endCursor hasNextPage }';

interface RestComment { id: number; body: string | null; user: { login: string } | null; html_url: string; created_at?: string; submitted_at?: string }
function comment(item: RestComment): Comment {
  if (!Number.isSafeInteger(item?.id)) throw new Error('Invalid GitHub comment');
  return { id: String(item.id), body: item.body, author: item.user?.login ?? null,
    url: item.html_url, createdAt: item.created_at ?? item.submitted_at ?? '' };
}

export async function fetchComments(github: GitHub, root: string, number: number) {
  const comments = [];
  for await (const item of github.pages<RestComment>(`${root}/issues/${number}/comments?per_page=100`, data => data as RestComment[])) {
    comments.push(comment(item));
  }
  return comments;
}

export async function fetchReviews(github: GitHub, root: string, number: number) {
  const reviews = [];
  for await (const item of github.pages<RestComment & { state: string }>(`${root}/pulls/${number}/reviews?per_page=100`,
    data => data as Array<RestComment & { state: string }>)) {
    reviews.push({ ...comment(item), state: item.state });
  }
  return reviews;
}

export async function fetchThreads(github: GitHub, id: string): Promise<Threads['threads']> {
  const threads = [];
  const list = await github.graphPages(`query($id:ID!, $cursor:String) {
    node(id:$id) { ... on PullRequest { reviewThreads(first:100, after:$cursor) {
      ${pageFields} nodes { id path line diffSide isResolved isOutdated }
    } } }
  }`, { id }, data => data.node?.reviewThreads);
  for (const thread of list) {
    const items = await github.graphPages(`query($id:ID!, $cursor:String) {
      node(id:$id) { ... on PullRequestReviewThread { comments(first:100, after:$cursor) {
        ${pageFields} nodes { id body author { login } url createdAt replyTo { id } }
      } } }
    }`, { id: thread.id }, data => data.node?.comments);
    threads.push({ ...thread, comments: items.map(item => ({ ...item, author: item.author?.login ?? null })) });
  }
  return threads;
}
