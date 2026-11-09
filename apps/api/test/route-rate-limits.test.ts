import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RateLimiter } from '../src/modules/auth/domain/ports.js';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import {
  ROUTE_RATE_LIMITS,
  routeLimiter,
  type RouteLimitScope,
  type RouteRateLimits,
} from '../src/shared/rate-limits.js';
import { RateLimitedError } from '../src/modules/auth/domain/errors.js';
import { RateLimiterUnavailableError } from '../src/shared/guarded-limit.js';
import { INVITE_LIMITS } from '../src/modules/organizations/application/organization.service.js';
import { createServer } from '../src/server.js';
import { mediaWorld, type MediaWorld } from './media-helpers.js';
import { fakeHasher, type Client } from './helpers.js';

/** Records every key consumed; can be switched to throw (limiter store down) or to never settle. */
function spyLimiter(inner: RateLimiter = new InMemoryRateLimiter({ now: () => new Date() })) {
  const keys: string[] = [];
  let mode: 'up' | 'down' | 'hang' = 'up';
  const limiter: RateLimiter = {
    consume: async (key, limit, windowMs) => {
      keys.push(key);
      if (mode === 'down') throw new Error('ECONNREFUSED redis');
      if (mode === 'hang') return new Promise(() => {});
      return inner.consume(key, limit, windowMs);
    },
  };
  return { limiter, keys, set: (m: typeof mode) => (mode = m) };
}

const one = { limit: 1, windowMs: 60_000 };
const big = { limit: 1_000, windowMs: 60_000 };
const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-11-01T00:00:00.000Z';

type Res = { statusCode: number; headers: Record<string, unknown>; json: () => unknown };
const code = (r: Res) => (r.json() as { error?: { code?: string } }).error?.code;
const expect429 = (r: Res) => {
  expect(r.statusCode).toBe(429);
  expect(code(r)).toBe('RATE_LIMITED');
  expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
};
const expect503 = (r: Res) => {
  expect(r.statusCode).toBe(503);
  expect(code(r)).toBe('PROVIDER_UNAVAILABLE');
  expect(r.headers['retry-after']).toBe('5');
};

describe('routeLimiter (shared/rate-limits.ts)', () => {
  it('keys per org + user and per org, and charges the org only after the user bucket allowed it', async () => {
    const spy = spyLimiter();
    const rl = routeLimiter(spy.limiter, {
      analytics: { perUser: { limit: 1, windowMs: 60_000 }, perOrg: big },
    });
    await rl.charge('analytics', { organizationId: 'o1', userId: 'u1' });
    await expect(
      rl.charge('analytics', { organizationId: 'o1', userId: 'u1' }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(spy.keys).toEqual([
      'rl:analytics:org:o1:user:u1',
      'rl:analytics:org:o1',
      'rl:analytics:org:o1:user:u1',
    ]);
  });

  it('one org cannot spend another org budget (per-tenant isolation)', async () => {
    const rl = routeLimiter(new InMemoryRateLimiter({ now: () => new Date() }), {
      downloadUrl: { perUser: big, perOrg: { limit: 2, windowMs: 60_000 } },
    });
    await rl.charge('downloadUrl', { organizationId: 'a', userId: 'u1' });
    await rl.charge('downloadUrl', { organizationId: 'a', userId: 'u2' });
    await expect(
      rl.charge('downloadUrl', { organizationId: 'a', userId: 'u3' }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      rl.charge('downloadUrl', { organizationId: 'b', userId: 'u1' }),
    ).resolves.toBeUndefined();
  });

  it('public scopes key on the client IP', async () => {
    const spy = spyLimiter();
    const rl = routeLimiter(spy.limiter, { unsubscribe: { perIp: one } });
    await rl.charge('unsubscribe', { ip: '198.51.100.1' });
    await expect(rl.charge('unsubscribe', { ip: '198.51.100.1' })).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    await expect(rl.charge('unsubscribe', { ip: '198.51.100.2' })).resolves.toBeUndefined();
    expect(spy.keys[0]).toBe('rl:unsubscribe:ip:198.51.100.1');
  });

  it('fails closed: a store error or a hung store is 503 RateLimiterUnavailableError, never a pass', async () => {
    const spy = spyLimiter();
    const rl = routeLimiter(spy.limiter);
    spy.set('down');
    await expect(
      rl.charge('analytics', { organizationId: 'o', userId: 'u' }),
    ).rejects.toBeInstanceOf(RateLimiterUnavailableError);
    spy.set('hang');
    await expect(rl.charge('unsubscribe', { ip: '198.51.100.1' })).rejects.toBeInstanceOf(
      RateLimiterUnavailableError,
    );
  }, 10_000);

  it('refuses an authenticated scope without a caller instead of sharing one bucket', async () => {
    const rl = routeLimiter(new InMemoryRateLimiter({ now: () => new Date() }));
    await expect(rl.charge('analytics', {})).rejects.toThrow(/no caller/);
  });

  it('every default bucket is a positive limit with a window', () => {
    for (const [scope, l] of Object.entries(ROUTE_RATE_LIMITS)) {
      const windows = [l.perIp, l.perUser, l.perOrg].filter(Boolean);
      expect(windows.length, scope).toBeGreaterThan(0);
      for (const w of windows) {
        expect(w!.limit, scope).toBeGreaterThan(0);
        expect(w!.windowMs, scope).toBeGreaterThan(0);
      }
    }
  });
});

describe('route rate limits over HTTP (P9 remaining-work #9)', () => {
  let w: MediaWorld | undefined;
  afterEach(async () => w?.app.close());

  const setup = async (routeRateLimits: Partial<RouteRateLimits>) => {
    const spy = spyLimiter();
    w = await mediaWorld({ rateLimiter: spy.limiter, routeRateLimits });
    return { ...w, ...spy };
  };

  type Case = {
    scope: RouteLimitScope;
    name: string;
    call: (s: MediaWorld, c?: Client, org?: string) => Promise<Res>;
    /** Org-admin route: only the owner may call it, so there is no same-org peer to compare with. */
    ownerOnly?: boolean;
  };
  const authed: Case[] = [
    {
      scope: 'downloadUrl',
      name: 'GET /orgs/:org/uploads/:id/download-url',
      call: (s, c = s.member, org = s.org) =>
        c.get(`/orgs/${org}/uploads/${randomUUID()}/download-url`),
    },
    {
      scope: 'analytics',
      name: 'GET /orgs/:org/analytics/meetings',
      call: (s, c = s.member, org = s.org) =>
        c.get(`/orgs/${org}/analytics/meetings?from=${FROM}&to=${TO}`),
    },
    {
      scope: 'analytics',
      name: 'GET /orgs/:org/analytics/tasks',
      call: (s, c = s.member, org = s.org) =>
        c.get(`/orgs/${org}/analytics/tasks?from=${FROM}&to=${TO}`),
    },
    {
      scope: 'calendarEvents',
      name: 'GET /orgs/:org/calendar/events',
      call: (s, c = s.member, org = s.org) =>
        c.get(`/orgs/${org}/calendar/events?from=${FROM}&to=${TO}`),
    },
    {
      scope: 'oauthConnect',
      name: 'POST /orgs/:org/calendar/connect',
      call: (s, c = s.member, org = s.org) =>
        c.post(`/orgs/${org}/calendar/connect`, { provider: 'google' }),
    },
    {
      scope: 'oauthConnect',
      name: 'POST /orgs/:org/integrations/connect',
      ownerOnly: true,
      call: (s, c = s.owner, org = s.org) =>
        c.post(`/orgs/${org}/integrations/connect`, { provider: 'github' }),
    },
    {
      scope: 'issuePush',
      name: 'POST /orgs/:org/tasks/:taskId/integration-issues',
      ownerOnly: true,
      call: (s, c = s.owner, org = s.org) =>
        c.post(`/orgs/${org}/tasks/${randomUUID()}/integration-issues`, {
          integrationId: randomUUID(),
          approvalId: randomUUID(),
          target: 'acme/repo',
        }),
    },
    {
      scope: 'pushDeviceRegister',
      name: 'POST /me/push-devices',
      // Bound to the caller's active organization (no org in the path).
      call: (s, c = s.member) =>
        c.post('/me/push-devices', {
          provider: 'expo',
          token: `ExponentPushToken[${randomUUID().replace(/-/g, '')}]`,
          platform: 'ios',
        }),
    },
  ];

  for (const k of authed) {
    it(`${k.name}: 429 + Retry-After over ${k.scope}.perUser, other users and orgs unaffected`, async () => {
      const s = await setup({ [k.scope]: { perUser: one, perOrg: big } });
      const first = await k.call(s);
      expect(first.statusCode, JSON.stringify(first.json())).not.toBe(429);
      // (An unconfigured provider may answer 503 itself; the limiter's own 503 is PROVIDER_UNAVAILABLE + Retry-After 5.)
      expect(first.headers['retry-after']).toBeUndefined();
      expect(s.keys.some((key) => key.startsWith(`rl:${k.scope}:org:${s.org}:user:`))).toBe(true);
      expect429(await k.call(s));
      // Another user of the same org has their own bucket ...
      if (!k.ownerOnly) expect((await k.call(s, s.owner)).statusCode).not.toBe(429);
      // ... and the owner of another org never shares a key with this one.
      expect((await k.call(s, s.other, s.otherOrg)).statusCode).not.toBe(429);
    });

    it(`${k.name}: limiter store down -> 503 + Retry-After (fail closed)`, async () => {
      const s = await setup({});
      s.set('down');
      expect503(await k.call(s));
    });
  }

  it('per-org ceiling: one org exhausting its budget does not throttle another org', async () => {
    const s = await setup({ analytics: { perUser: big, perOrg: { limit: 2, windowMs: 60_000 } } });
    const q = `analytics/meetings?from=${FROM}&to=${TO}`;
    expect((await s.owner.get(`/orgs/${s.org}/${q}`)).statusCode).toBe(200);
    expect((await s.member.get(`/orgs/${s.org}/${q}`)).statusCode).toBe(200);
    expect429(await s.viewer.get(`/orgs/${s.org}/${q}`));
    expect((await s.other.get(`/orgs/${s.otherOrg}/${q}`)).statusCode).toBe(200);
  });

  it('a request for another org is rejected by the tenancy check before any bucket is charged', async () => {
    const s = await setup({ analytics: { perUser: one, perOrg: one } });
    s.keys.length = 0;
    const r = await s.other.get(`/orgs/${s.org}/analytics/meetings?from=${FROM}&to=${TO}`);
    expect(r.statusCode).toBe(404);
    expect(s.keys.filter((key) => key.startsWith('rl:analytics'))).toEqual([]);
    expect(
      (await s.owner.get(`/orgs/${s.org}/analytics/meetings?from=${FROM}&to=${TO}`)).statusCode,
    ).toBe(200);
  });

  const publicCases: {
    scope: RouteLimitScope;
    name: string;
    url: string;
    method: 'GET' | 'POST';
  }[] = [
    {
      scope: 'unsubscribe',
      name: 'GET /notifications/unsubscribe',
      method: 'GET',
      url: '/notifications/unsubscribe?token=aaaaaaaaaaaaaaaaaaaa.bbbbbbbb',
    },
    {
      scope: 'unsubscribe',
      name: 'POST /notifications/unsubscribe',
      method: 'POST',
      url: '/notifications/unsubscribe?token=aaaaaaaaaaaaaaaaaaaa.bbbbbbbb',
    },
    {
      scope: 'oauthCallback',
      name: 'GET /integrations/:provider/callback',
      method: 'GET',
      url: `/integrations/github/callback?state=${'s'.repeat(43)}`,
    },
    {
      scope: 'oauthCallback',
      name: 'GET /calendar/:provider/callback',
      method: 'GET',
      url: '/calendar/google/callback?state=abc',
    },
  ];
  for (const p of publicCases) {
    const send = (s: MediaWorld, ip: string) =>
      s.app.inject({
        method: p.method,
        url: p.url,
        remoteAddress: ip,
        headers:
          p.method === 'POST'
            ? {
                'content-type': 'application/x-www-form-urlencoded',
                origin: 'http://localhost:5173',
              }
            : {},
        ...(p.method === 'POST' ? { payload: 'List-Unsubscribe=One-Click' } : {}),
      });
    it(`${p.name}: per-IP 429 + Retry-After before any token or session work; other IPs unaffected`, async () => {
      const s = await setup({ [p.scope]: { perIp: one } });
      const first = await send(s, '198.51.100.10');
      expect(first.statusCode).not.toBe(429);
      expect(s.keys).toContain(`rl:${p.scope}:ip:198.51.100.10`);
      expect429(await send(s, '198.51.100.10'));
      expect((await send(s, '198.51.100.11')).statusCode).not.toBe(429);
    });
    it(`${p.name}: limiter store down -> 503 + Retry-After`, async () => {
      const s = await setup({});
      s.set('down');
      expect503(await send(s, '198.51.100.10'));
    });
  }

  it('POST /orgs: per-user 429 + Retry-After (key has no org yet); another user unaffected; store down -> 503', async () => {
    const s = await setup({ orgCreate: { perUser: one } });
    // setup already created the owner's first org, which used up the owner's one-per-window budget.
    expect429(await s.owner.post('/orgs', { name: 'Second' }));
    expect(s.keys.filter((k) => k.startsWith('rl:orgCreate:user:')).length).toBeGreaterThan(0);
    expect((await s.member.post('/orgs', { name: 'Member Co' })).statusCode).toBe(201);
    s.set('down');
    expect503(await s.viewer.post('/orgs', { name: 'Viewer Co' }));
  });

  it('invitation accept: per-user bucket holds when the caller rotates IPs; limiter down -> 503', async () => {
    const s = await setup({});
    const accept = (ip: string) =>
      s.app.inject({
        method: 'POST',
        url: '/invitations/accept',
        remoteAddress: ip,
        headers: {
          cookie: s.other.cookie,
          origin: 'http://localhost:5173',
          'x-csrf-token': s.other.jar.get('__Host-meetops_csrf') ?? '',
        },
        payload: { token: 'x'.repeat(43) },
      });
    const n = INVITE_LIMITS.acceptPerUser.limit;
    s.keys.length = 0;
    for (let i = 0; i < n; i++) expect((await accept(`198.51.100.${i + 1}`)).statusCode).toBe(404);
    expect429(await accept('198.51.100.200'));
    expect(s.keys.filter((k) => k.startsWith('invite:accept:user:')).length).toBe(n + 1);
    s.set('down');
    expect503(await accept('198.51.100.201'));
  });
});

describe('public routes key on the ADR-014 client IP, not the proxy or a spoofed header', () => {
  it('TRUST_PROXY allowlisted peer: X-Forwarded-For client is the key; untrusted peer: XFF ignored', async () => {
    const spy = spyLimiter();
    const app = createServer({
      trustProxy: '10.0.0.1',
      nodeEnv: 'test',
      deps: {
        hasher: fakeHasher,
        rateLimiter: spy.limiter,
        routeRateLimits: { unsubscribe: { perIp: big } },
      },
    });
    await app.ready();
    try {
      const url = '/notifications/unsubscribe?token=aaaaaaaaaaaaaaaaaaaa.bbbbbbbb';
      await app.inject({
        method: 'GET',
        url,
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      await app.inject({
        method: 'GET',
        url,
        remoteAddress: '192.0.2.50',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      expect(spy.keys.filter((k) => k.startsWith('rl:unsubscribe'))).toEqual([
        'rl:unsubscribe:ip:203.0.113.9',
        'rl:unsubscribe:ip:192.0.2.50',
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('inbound webhooks fail closed (P9 #9)', () => {
  it('limiter store down -> 503 + Retry-After before any signature or DB work (was an unhandled 500)', async () => {
    const spy = spyLimiter();
    spy.set('down');
    const app = createServer({
      nodeEnv: 'test',
      deps: { hasher: fakeHasher, rateLimiter: spy.limiter },
    });
    await app.ready();
    try {
      for (const url of ['/webhooks/github', `/webhooks/jira/${randomUUID()}`]) {
        const r = await app.inject({
          method: 'POST',
          url,
          payload: '{}',
          headers: { 'content-type': 'application/json', 'x-github-event': 'ping' },
          remoteAddress: '203.0.113.7',
        });
        expect503(r);
        expect(spy.keys.at(-1)).toBe('webhook:ip:203.0.113.7');
      }
    } finally {
      await app.close();
    }
  });
});
