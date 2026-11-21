import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'diffloop-oauth-'));
try {
  const modulePath = join(directory, 'oauth.mjs');
  await build({ entryPoints: ['src/oauth.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'esm' });
  const { githubOAuth, verificationUrl } = await import(modulePath);
  const clientId = 'exampleClientId';
  let time = 0;
  let responses = [];
  const requests = [];
  const tokens = [];
  const sleep = async ms => { time += ms; };
  const request = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://github.com');
    assert.equal(options.body.get('client_id'), clientId);
    assert.equal(options.redirect, 'error');
    requests.push({ url, body: options.body, time });
    return Response.json(responses.shift());
  };
  const challenge = { device_code: 'device-secret', user_code: 'ABCD-1234', verification_uri: verificationUrl,
    expires_in: 900, interval: 5 };

  const oauth = githubOAuth(clientId, async token => { tokens.push(token); }, request, sleep, () => time);
  assert.equal(githubOAuth(undefined, async () => {}).configured, false);
  responses = [challenge, { error: 'authorization_pending' }, { error: 'slow_down', interval: 10 },
    { access_token: 'fixture_token', token_type: 'bearer' }];
  assert.deepEqual(await oauth.start(false), { userCode: 'ABCD-1234', expiresAt: 900000 });
  assert.equal(requests[0].body.get('scope'), '');
  await assert.rejects(oauth.start(true), /already in progress/);
  await oauth.finish();
  assert.deepEqual(tokens, ['fixture_token']);
  assert.deepEqual(requests.slice(1).map(item => item.time), [5000, 10000, 20000]);
  assert.ok(requests.slice(1).every(item => item.body.get('device_code') === 'device-secret'));

  responses = [challenge, { error: 'access_denied' }];
  await oauth.start(true);
  assert.equal(requests.at(-1).body.get('scope'), 'repo');
  await assert.rejects(oauth.finish(), /declined/);
  responses = [{ ...challenge, expires_in: 5 }];
  await oauth.start(false);
  await assert.rejects(oauth.finish(), /expired/);
  responses = [{ ...challenge, verification_uri: 'https://example.org' }];
  await assert.rejects(oauth.start(false), /invalid device code response/);

  responses = [challenge];
  const cancellable = githubOAuth(clientId, async () => assert.fail('cancelled sign-in saved a token'), request,
    async (_ms, _value, { signal }) => new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })), () => time);
  await cancellable.start(false);
  const waiting = cancellable.finish();
  cancellable.cancel();
  await assert.rejects(waiting, /cancelled/);
  console.log('OAuth fixtures passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
