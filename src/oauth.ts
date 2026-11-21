import { setTimeout as delay } from 'node:timers/promises';
import type { DeviceCode } from './api';

export const verificationUrl = 'https://github.com/login/device';

export function githubOAuth(clientId: string | undefined, connect: (token: string, signal: AbortSignal) => Promise<void>,
  request = fetch, sleep = delay, now = Date.now) {
  const configured = /^[a-zA-Z0-9_]{8,128}$/.test(clientId ?? '');
  interface Attempt {
    controller: AbortController;
    deviceCode?: string;
    expiresAt: number;
    nextPoll: number;
    interval: number;
    waiting: boolean;
  }
  let active: Attempt | undefined;

  async function post(path: string, params: Record<string, string>, signal: AbortSignal) {
    const response = await request(`https://github.com${path}`, {
      method: 'POST', headers: { Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId!, ...params }), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    }).catch(() => {
      signal.throwIfAborted();
      throw new Error('Could not reach GitHub sign-in. Try again.');
    });
    if (!response.ok) throw new Error(`GitHub sign-in returned HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  }

  function cancel() {
    active?.controller.abort();
    active = undefined;
  }

  function errorFor(code: unknown) {
    if (code === 'device_flow_disabled') return new Error('Enable Device Flow in the GitHub OAuth app settings');
    if (code === 'incorrect_client_credentials') return new Error('Check the GitHub OAuth client ID');
    if (code === 'access_denied') return new Error('GitHub authorization was declined');
    if (code === 'expired_token' || code === 'token_expired') return new Error('The GitHub code expired. Start sign-in again.');
    return new Error('GitHub could not authorize this sign-in');
  }

  return {
    configured,
    cancel,
    async start(privateRepos: boolean): Promise<DeviceCode> {
      if (!configured) throw new Error('GitHub OAuth is not configured');
      if (active && active.expiresAt > now()) throw new Error('GitHub sign-in is already in progress');
      cancel();
      const attempt: Attempt = { controller: new AbortController(), expiresAt: Infinity, nextPoll: 0, interval: 0, waiting: false };
      active = attempt;
      try {
        const data = await post('/login/device/code', { scope: privateRepos ? 'repo' : '' }, attempt.controller.signal);
        attempt.controller.signal.throwIfAborted();
        if (data.error) throw errorFor(data.error);
        const { device_code, user_code, verification_uri, expires_in, interval } = data;
        if (typeof device_code !== 'string' || !device_code || typeof user_code !== 'string' ||
          !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(user_code) || verification_uri !== verificationUrl ||
          typeof expires_in !== 'number' || !Number.isSafeInteger(expires_in) || expires_in <= 0 || expires_in > 3600 ||
          typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval <= 0 || interval > expires_in) {
          throw new Error('GitHub returned an invalid device code response');
        }
        attempt.deviceCode = device_code;
        attempt.interval = interval * 1000;
        attempt.expiresAt = now() + expires_in * 1000;
        attempt.nextPoll = now() + attempt.interval;
        return { userCode: user_code, expiresAt: attempt.expiresAt };
      } catch (error) {
        if (active === attempt) cancel();
        throw error;
      }
    },
    async finish() {
      const attempt = active;
      if (!attempt?.deviceCode || attempt.waiting) throw new Error('Start a GitHub sign-in first');
      attempt.waiting = true;
      const signal = attempt.controller.signal;
      try {
        while (now() < attempt.expiresAt) {
          await sleep(Math.max(0, Math.min(attempt.nextPoll, attempt.expiresAt) - now()), undefined, { signal });
          if (now() >= attempt.expiresAt) break;
          const result = await post('/login/oauth/access_token', {
            device_code: attempt.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }, signal);
          signal.throwIfAborted();
          if (typeof result.access_token === 'string' && /^[\w]{1,512}$/.test(result.access_token) &&
            result.token_type === 'bearer') {
            await connect(result.access_token, signal);
            return;
          }
          if (result.error === 'slow_down') {
            const interval = result.interval;
            attempt.interval = Math.max(attempt.interval + 5000,
              typeof interval === 'number' && Number.isSafeInteger(interval) && interval <= 3600 ? interval * 1000 : 0);
          } else if (result.error !== 'authorization_pending') {
            throw errorFor(result.error);
          }
          attempt.nextPoll = now() + attempt.interval;
        }
        throw errorFor('expired_token');
      } catch (error) {
        if (signal.aborted) throw new Error('GitHub sign-in cancelled');
        throw error;
      } finally {
        if (active === attempt) cancel();
      }
    },
  };
}
