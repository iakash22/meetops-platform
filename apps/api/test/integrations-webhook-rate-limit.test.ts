import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { ModuleDeps } from '../src/modules/index.js';
import {
  WEBHOOK_RATE_LIMITS,
  type IntegrationsModuleDeps,
} from '../src/modules/integrations/index.js';
import { devIntegrationsRuntime } from '../src/modules/integrations/runtime.js';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
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

  let repo: InMemoryIntegrations;
  const startWithGitHub = (limits: IntegrationsModuleDeps['webhookRateLimits']) =>
    buildApp({
      webhookRateLimits: limits,
      integrations: (repo = new InMemoryIntegrations()),
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
    a.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: '{}',
      headers,
      remoteAddress: ip,
    });

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
    seedGitHub();
    for (let i = 0; i < 2; i++)
      expect((await send(app, '/webhooks/github', delivery())).statusCode).toBe(202);
    const r = await send(app, '/webhooks/github', delivery());
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
    seedGitHub();
    expect((await send(app, '/webhooks/github', delivery())).statusCode).toBe(202);
  });

  const seedGitHub = () => {
    const id = randomUUID();
    repo.add(
      {
        id,
        organizationId: randomUUID(),
        provider: 'github',
        status: 'active',
        displayName: 'acme',
        externalAccountId: '99',
        connectedById: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { accessToken: 'a', refreshToken: null, webhookSecret: 'unused' },
    );
    return id;
  };
  const issueBody = JSON.stringify({
    action: 'opened',
    issue: { number: 1, state: 'open' },
    repository: { full_name: 'acme/app' },
    installation: { id: 99 },
  });
  const delivery = () => ({ ...signed(issueBody), 'x-github-event': 'issues' });
  const send = (a: App, url: string, headers: Record<string, string>) =>
    a.inject({ method: 'POST', url, payload: issueBody, headers, remoteAddress: '203.0.113.7' });

  it('replaying one valid delivery does not use up the github-app bucket', async () => {
    app = await startWithGitHub({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 2, windowMs: 60_000 },
      unsignedPerIp: { limit: 50, windowMs: 60_000 },
    });
    seedGitHub();
    const h = delivery();
    expect((await send(app, '/webhooks/github', h)).statusCode).toBe(202);
    for (let i = 0; i < 5; i++)
      expect((await send(app, '/webhooks/github', h)).statusCode).toBe(409);
    expect((await send(app, '/webhooks/github', delivery())).statusCode).toBe(202);
    expect((await send(app, '/webhooks/github', delivery())).statusCode).toBe(429);
  });

  it('per-integration bucket is charged only after signature and replay checks', async () => {
    app = await startWithGitHub({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 2, windowMs: 60_000 },
      unsignedPerIp: { limit: 50, windowMs: 60_000 },
    });
    const id = seedGitHub();
    const url = `/webhooks/github/${id}`;
    for (let i = 0; i < 5; i++) {
      expect((await post(app, url)).statusCode).toBe(401);
      expect(
        (await send(app, url, { ...delivery(), ...signed(issueBody, 'wrong') })).statusCode,
      ).toBe(401);
    }
    const h = delivery();
    expect((await send(app, url, h)).statusCode).toBe(202);
    for (let i = 0; i < 5; i++) expect((await send(app, url, h)).statusCode).toBe(409);
    expect((await send(app, url, delivery())).statusCode).toBe(202);
    const r = await send(app, url, delivery());
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('per-target limits are independent per integration', async () => {
    app = await startWithGitHub({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 1, windowMs: 60_000 },
    });
    const a = `/webhooks/github/${seedGitHub()}`;
    const b = `/webhooks/github/${seedGitHub()}`;
    expect((await send(app, a, delivery())).statusCode).toBe(202);
    expect((await send(app, a, delivery())).statusCode).toBe(429);
    expect((await send(app, b, delivery())).statusCode).toBe(202);
  });

  it('unknown integration ids are treated as unsigned (small per-IP bucket)', async () => {
    app = await startWithGitHub({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 100, windowMs: 60_000 },
      unsignedPerIp: { limit: 1, windowMs: 60_000 },
    });
    expect((await post(app, `/webhooks/github/${randomUUID()}`)).statusCode).toBe(401);
    expect((await post(app, `/webhooks/jira/${randomUUID()}`)).statusCode).toBe(429);
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
