import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ModuleDeps } from '../src/modules/index.js';
import {
  WEBHOOK_RATE_LIMITS,
  type IntegrationsModuleDeps,
} from '../src/modules/integrations/index.js';
import { buildApp, type App } from './helpers.js';

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

  it('per-target: the App-wide route returns 429 with Retry-After once over the limit', async () => {
    app = await start({
      perIp: { limit: 100, windowMs: 60_000 },
      perTarget: { limit: 2, windowMs: 60_000 },
    });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await post(app, '/webhooks/github')).statusCode);
    expect(codes.slice(0, 2).every((c) => c !== 429)).toBe(true);
    const r = await post(app, '/webhooks/github');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
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
