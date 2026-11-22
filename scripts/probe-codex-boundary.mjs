// Capture a synthetic model request over loopback and stop before any tool can run.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cwd = await mkdtemp(join(tmpdir(), 'diffloop-codex-'));
await mkdir(join(cwd, 'skills', 'fixture-unselected'), { recursive: true });
await writeFile(join(cwd, 'skills', 'fixture-unselected', 'SKILL.md'),
  '---\nname: fixture-unselected\ndescription: Synthetic unselected skill\n---\nFixture only.\n');
const { promise: captured, resolve: observe } = Promise.withResolvers();
const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === '/v1/responses') observe(JSON.parse(Buffer.concat(chunks)));
  res.writeHead(400, {'content-type': 'application/json'}).end(JSON.stringify({error:{message:'Synthetic probe ends here'}}));
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${mock.address().port}/v1`;
const server = spawn('codex', ['app-server', '--listen', 'stdio://',
  '-c', 'model_provider="fixture"', '-c', 'model_providers.fixture.name="Fixture"',
  '-c', `model_providers.fixture.base_url="${origin}"`,
  '-c', 'model_providers.fixture.wire_api="responses"',
  '-c', 'web_search="disabled"',
  '--enable', 'skip_host_skill_discovery', '--enable', 'omit_skill_descriptions',
  ...['shell_tool', 'unified_exec', 'plugins', 'apps', 'hooks', 'multi_agent', 'multi_agent_v2', 'image_generation', 'goals', 'view_image', 'default_mode_request_user_input', 'skill_search'].flatMap(name => ['--disable', name]),
], { cwd, env: { ...process.env, CODEX_HOME: cwd }, stdio: ['pipe', 'pipe', 'ignore'] });
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
  await rpc('initialize', { clientInfo: { name: 'diffloop_probe', version: '0.1' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
  const session = await rpc('thread/start', {
    cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
    model: 'gpt-5.4',
    dynamicTools: [{type: 'function', name: 'diffloop_list', description: 'List synthetic context',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }}],
  });
  const { thread } = session;
  await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Review synthetic fixture only.', text_elements: [] }] });
  let deadline;
  try {
    const payload = await Promise.race([captured, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('No model request captured')), 10000); })]);
    const unexpected = payload.tools.filter(tool => tool.name !== 'diffloop_list').map(tool => tool.name ?? tool.type);
    const unselectedSkill = JSON.stringify(payload.input).includes('fixture-unselected');
    if (!payload.tools.some(tool => tool.name === 'diffloop_list')) throw new Error('Synthetic review tool missing');
    console.log('Unexpected tools:', unexpected.join(', ') || 'none');
    console.log('Unselected skill advertised:', unselectedSkill);
    if (unexpected.length || unselectedSkill) throw new Error('Effective Codex tool/context allowlist failed');
    console.log('PASS model request allowlist');
  } finally { clearTimeout(deadline); }
} catch (error) {
  console.error('FAIL', error.message);
  process.exitCode = 1;
} finally {
  mock.close();
  server.stdin.end();
  server.kill();
  const forceClose = setTimeout(() => server.kill('SIGKILL'), 2000);
  await closed;
  clearTimeout(forceClose);
  await rm(cwd, { recursive: true, force: true });
}
