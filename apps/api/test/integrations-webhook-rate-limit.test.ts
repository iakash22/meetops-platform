import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { ModuleDeps } from '../src/modules/index.js';
import {
  WEBHOOK_RATE_LIMITS,
  type IntegrationsModuleDeps,
} from '../src/modules/integrations/index.js';
import { devIntegrationsRuntime } from '../src/modules/integrations/runtime.js';
import { buildApp, type App } from './helpers.js';

const GH_SECRET = 'gh-app-webhook-secret';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const signed = (body: string, secret = GH_SECRET) => ({
  'content-type': 'application/json',
  'x-github-event': 'ping',
  'x-github-delivery': randomUUID(),
  'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
});

const unsigned = { 'content-type': 'application/json', 'x-github-event': 'ping' };

describe('integration webhook rate limits (P9 coverage)', () => {
  let app: App | undefined;
  afterEach(async () => app?.close());

  const start = (limits: IntegrationsModuleDeps['webhookRateLimits']) =>
    buildApp({ webhookRateLimits: limits } as Partial<ModuleDeps>);
  const post = (a: App, url: string, ip = '203.0.113.7') =>
    a.inject({ method: 'POST', url, payload: '{}', headers: unsigned, remoteAddress: ip });

  it('has generous defaults', () => {
    expect(WEBHOOK_RATE_LIMITS.perIp.limit).toBeGreaterThanOrEqual(100);
    expect(WEBHOOK_RATE_LIMITS.perTarget.limit).toBeGreaterThanOrEqual(100);
  });

  const startWithGitHub = (limits: IntegrationsModuleDeps['webhookRateLimits']) =>
    buildApp({
      webhookRateLimits: limits,
      integrationsRuntime: devIntegrationsRuntime({
        apiOrigin: 'http://api.test',
        github: {
          appSlug: 'meetops-test',
          appId: '123',
          clientId: 'Iv1.abc',
          privateKey: async () => pem,
          clientSecret: async () => 'gh-client-secret',
          webhookSecret: async () => GH_SECRET,
        },
      }),
    } as Partial<ModuleDeps>);
  const postSigned = (a: App, headers: Record<string, string>, ip = '203.0.113.7') =>
    a.inject({ method: 'POST', url: '/webhooks/github', payload: '{}', headers, remoteAddress: ip });

  it('per-target: the App-wide route charges the github-app bucket only for signed deliveries', async () => {
    app = await startWithGitHub({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 2, windowMs: 60_000 },
      unsignedPerIp: { limit: 50, windowMs: 60_000 },
    });
    // Unsigned/invalid floods are 401 and do not consume the shared 'github-app' bucket.
    for (let i = 0; i < 5; i++) {
      expect((await post(app, '/webhooks/github')).statusCode).toBe(401);
      expect((await postSigned(app, signed('{}', 'wrong'))).statusCode).toBe(401);
    }
    const codes: number[] = [];
    for (let i = 0; i < 2; i++) codes.push((await postSigned(app, signed('{}'))).statusCode);
    expect(codes.every((c) => c !== 429)).toBe(true);
    const r = await postSigned(app, signed('{}'));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  it('unsigned/invalid App-wide deliveries hit a separate small per-IP bucket', async () => {
    app = await startWithGitHub({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 100, windowMs: 60_000 },
      unsignedPerIp: { limit: 2, windowMs: 60_000 },
    });
    expect((await post(app, '/webhooks/github')).statusCode).toBe(401);
    expect((await postSigned(app, signed('{}', 'wrong'))).statusCode).toBe(401);
    const r = await post(app, '/webhooks/github');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // Per client: another IP still gets a plain 401 ...
    expect((await post(app, '/webhooks/github', '198.51.100.9')).statusCode).toBe(401);
    // ... and genuinely signed deliveries from the throttled IP are unaffected.
    expect((await postSigned(app, signed('{}'))).statusCode).not.toBe(429);
  });

  it('per-target limits are independent per integration', async () => {
    app = await start({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 1, windowMs: 60_000 },
    });
    const a = `/webhooks/github/${randomUUID()}`;
    const b = `/webhooks/github/${randomUUID()}`;
    expect((await post(app, a)).statusCode).not.toBe(429);
    expect((await post(app, a)).statusCode).toBe(429);
    expect((await post(app, b)).statusCode).not.toBe(429);
  });

  it('per-IP limit spans all webhook routes and is per client', async () => {
    app = await start({
      perIp: { limit: 2, windowMs: 60_000 },
      perTarget: { limit: 100, windowMs: 60_000 },
    });
    expect((await post(app, `/webhooks/jira/${randomUUID()}`)).statusCode).not.toBe(429);
    expect((await post(app, '/webhooks/github')).statusCode).not.toBe(429);
    expect((await post(app, `/webhooks/github/${randomUUID()}`)).statusCode).toBe(429);
    expect(
      (await post(app, `/webhooks/github/${randomUUID()}`, '198.51.100.9')).statusCode,
    ).not.toBe(429);
  });
});
