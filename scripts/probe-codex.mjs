// Exercise the installed app server over stdio without submitting model input.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cwd = await mkdtemp(join(tmpdir(), 'diffloop-codex-'));
const server = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  cwd, stdio: ['pipe', 'pipe', 'ignore'],
});
const lines = createInterface({ input: server.stdout });
let sequence = 0;
const pending = new Map();
function fail(error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
server.on('error', fail);
server.stdin.on('error', fail);
const closed = new Promise(resolve => server.once('close', code => {
  fail(new Error(`app server closed (exit ${code})`));
  resolve();
}));
lines.on('line', line => {
  try {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request || message.method) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`RPC error ${message.error.code}`));
    else request.resolve(message.result);
  } catch {
    fail(new Error('invalid protocol output'));
  }
});
function send(message) {
  server.stdin.write(JSON.stringify(message) + '\n');
}
async function rpc(method, params) {
  const id = ++sequence;
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  } finally {
    clearTimeout(timeout);
    pending.delete(id);
  }
}
try {
  await rpc('initialize', { clientInfo: { name: 'diffloop_probe', version: '0.1' } });
  send({ method: 'initialized' });
  const { account } = await rpc('account/read', { refreshToken: false });
  if (account?.type !== 'chatgpt') throw new Error('ChatGPT sign-in required');
  console.log('PASS ChatGPT account');
  const { data } = await rpc('skills/list', { cwds: [cwd] });
  const entry = data.find(item => item.cwd === cwd);
  if (!Array.isArray(entry?.skills) || entry.errors?.length) throw new Error('skill discovery incomplete');
  console.log('PASS skill discovery');
  const catalog = await rpc('plugin/list', { cwds: [cwd], marketplaceKinds: ['local'], forceRefetch: false });
  if (!Array.isArray(catalog.marketplaces) || catalog.marketplaceLoadErrors?.length) {
    throw new Error('plugin discovery incomplete');
  }
  console.log('PASS plugin discovery');
  const session = await rpc('thread/start', {
    cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
  });
  if (!session.thread?.id || session.approvalPolicy !== 'never' ||
      session.sandbox?.type !== 'readOnly' || session.sandbox.networkAccess === true) {
    throw new Error('unexpected review session policy');
  }
  console.log('PASS ephemeral thread with read-only sandbox and approvals disabled');
} catch (error) {
  console.error('FAIL', error.message);
  process.exitCode = 1;
} finally {
  server.stdin.end();
  server.kill();
  const forceClose = setTimeout(() => server.kill('SIGKILL'), 2000);
  await closed;
  clearTimeout(forceClose);
  await rm(cwd, { recursive: true, force: true });
}
