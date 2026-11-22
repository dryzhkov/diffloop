import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RestrictedReviewRuntime } from './agents';

const restrictedCodexArgs = [
  'app-server', '--listen', 'stdio://',
  '-c', 'web_search="disabled"', '-c', 'cli_auth_credentials_store="file"',
  '--enable', 'skip_host_skill_discovery', '--enable', 'omit_skill_descriptions',
  ...['shell_tool', 'unified_exec', 'plugins', 'apps', 'hooks', 'multi_agent', 'multi_agent_v2',
    'image_generation', 'goals', 'view_image', 'skill_search'].flatMap(name => ['--disable', name]),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type RunInput = Parameters<RestrictedReviewRuntime['execute']>[0];
type NamedTool = { type: 'function'; name: string; description: string; inputSchema: object };

function reviewTools(tools: RunInput['tools']) {
  const handlers = new Map<string, (args: Record<string, unknown>) => unknown>();
  const specs: NamedTool[] = [];
  function register(name: string, description: string, properties: Record<string, object>,
    handler: (args: Record<string, unknown>) => unknown, required = Object.keys(properties)) {
    handlers.set(name, handler);
    specs.push({ type: 'function', name, description, inputSchema: {
      type: 'object', properties, required, additionalProperties: false,
    } });
  }
  const string = { type: 'string' };
  register('diffloop_list', 'List resources granted for this review.', {}, () => tools.list());
  register('diffloop_read', 'Read a granted resource by key.', { key: string }, args => tools.read(String(args.key)));
  register('diffloop_search', 'Search granted resources for literal text.', { query: string }, args => tools.search(String(args.query)));
  register('diffloop_finding', 'Save a defensive review finding with evidence and recommended remediation.', {
    title: string, explanation: string, evidence: string, suggestedComment: string,
    anchor: { type: 'object', additionalProperties: false,
      properties: { path: string, commitSha: string, side: { enum: ['base', 'head'] },
        startLine: { type: 'integer' }, endLine: { type: 'integer' } },
      required: ['path', 'commitSha', 'side', 'startLine', 'endLine'] },
  }, args => tools.addFinding(args as Parameters<typeof tools.addFinding>[0]), ['title', 'explanation', 'evidence']);
  if (tools.createDraft) {
    const createDraft = tools.createDraft;
    register('diffloop_draft', 'Create an editable local draft from a saved finding.', { findingId: string },
      args => { createDraft(String(args.findingId)); return 'Local draft saved.'; });
  }
  return { specs, handlers };
}

async function execute({ model, instructions, tools, signal }: RunInput) {
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), 'diffloop-codex-'));
  const cwd = join(root, 'workspace');
  const home = join(root, 'codex');
  try {
    await Promise.all([mkdir(cwd), mkdir(home, { mode: 0o700 })]);
    const auth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    try {
      await copyFile(auth, join(home, 'auth.json'));
    } catch {
      throw new Error('Sign in to Codex with ChatGPT using file credential storage, then retry.');
    }
    signal.throwIfAborted();
    await runServer(cwd, home, { model, instructions, tools, signal });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runServer(cwd: string, home: string, { model, instructions, tools, signal }: RunInput) {
  const { specs, handlers } = reviewTools(tools);
  const server = spawn('codex', restrictedCodexArgs, {
    cwd,
    env: { PATH: process.env.PATH, HOME: homedir(), CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: server.stdout });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const completed = deferred<void>();
  void completed.promise.catch(() => {});
  let threadId: string | undefined;
  let sequence = 0;
  function stop(error: Error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    completed.reject(error);
  }
  function send(message: object) {
    if (!server.stdin.destroyed) server.stdin.write(JSON.stringify(message) + '\n');
  }
  async function rpc(method: string, params: object) {
    signal.throwIfAborted();
    const id = ++sequence;
    const result = deferred<any>();
    const timer = setTimeout(() => result.reject(new Error(`Codex timed out during ${method}.`)), 20_000);
    pending.set(id, result);
    try {
      send({ id, method, params });
      return await result.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  const abort = () => {
    stop(new Error('Codex review cancelled.'));
    server.kill();
  };
  signal.addEventListener('abort', abort, { once: true });
  server.on('error', () => stop(new Error('Could not start Codex. Make sure codex is installed and on Diffloop’s PATH.')));
  server.stdin.on('error', () => stop(new Error('Codex stopped accepting requests.')));
  const closed = new Promise<void>(resolve => server.once('close', () => {
    stop(new Error('Codex exited before the review finished.'));
    resolve();
  }));

  async function receive(line: string) {
    const message = JSON.parse(line);
    const { id, method, params } = message;
    if (!method) {
      const request = pending.get(id);
      if (message.error) request?.reject(new Error('Codex rejected the session or review request.'));
      else request?.resolve(message.result);
    } else if (id != null) {
      if (signal.aborted) return;
      if (method === 'item/tool/requestUserInput') {
        send({ id, result: { answers: {} } });
      } else if (method === 'item/tool/call' && params?.threadId === threadId &&
          typeof params?.tool === 'string' && handlers.has(params.tool)) {
        let success = true;
        let output;
        try {
          output = await handlers.get(params.tool)!(params.arguments ?? {});
        } catch {
          success = false;
          output = 'The review tool could not complete that request. Check the granted resource or arguments.';
        }
        if (!signal.aborted) send({ id, result: { success, contentItems: [{ type: 'inputText', text: JSON.stringify(output) }] } });
      } else {
        send({ id, error: { code: -32601, message: 'Request unavailable in Diffloop review' } });
        stop(new Error('Codex requested an unsupported operation.'));
      }
    } else if (method === 'turn/completed' && params?.threadId === threadId) {
      if (params?.turn?.status === 'completed') completed.resolve();
      else {
        const detail = params?.turn?.error?.codexErrorInfo === 'modelNotFound'
          ? 'The selected model is unavailable to your Codex account. Update the model in Agent settings.'
          : 'Codex could not complete the review. Check your ChatGPT access and retry.';
        completed.reject(new Error(detail));
      }
    }
  }
  lines.on('line', line => { void receive(line).catch(() => stop(new Error('Invalid message from Codex.'))); });
  const timeout = setTimeout(() => stop(new Error('Codex review timed out.')), 10 * 60_000);
  try {
    await rpc('initialize', { clientInfo: { name: 'diffloop', version: '0.1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    const { account } = await rpc('account/read', { refreshToken: false });
    if (account?.type !== 'chatgpt') throw new Error('Sign in to Codex with ChatGPT and retry.');
    const session = await rpc('thread/start', {
      cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
      model, dynamicTools: specs,
    });
    if (typeof session.thread?.id !== 'string' || session.approvalPolicy !== 'never' ||
        session.sandbox?.type !== 'readOnly' || session.sandbox.networkAccess === true) {
      throw new Error('Codex returned an unsupported review session policy.');
    }
    threadId = session.thread.id;
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: instructions +
      '\nUse the Diffloop tools to read granted context and save each actionable finding. Finish when the review is complete.',
      text_elements: [] }] });
    await completed.promise;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    lines.close();
    server.stdin.end();
    server.kill();
    const force = setTimeout(() => server.kill('SIGKILL'), 2000);
    await closed;
    clearTimeout(force);
  }
}

export const codexRuntime: RestrictedReviewRuntime = { version: 'Codex app server', execute };
