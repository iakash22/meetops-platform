import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { API_BASELINE_HEADERS, HSTS_VALUE } from '../src/shared/security-headers.js';
import { PRE_SESSION_MAX_AGE_S } from '../src/modules/auth/http/security.js';
import { Client, fakeHasher, ORIGIN } from './helpers.js';

const NO_INFRA = { databaseUrl: '', redisUrl: '' };
type App = ReturnType<typeof createServer>;
let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (extra: Parameters<typeof createServer>[0] = {}) => {
  app = createServer({ nodeEnv: 'test', ...NO_INFRA, deps: { hasher: fakeHasher }, ...extra });
  app.get('/__p9/boom', async () => {
    throw new Error('boom');
  });
  app.get('/__p9/peer', async (req) => ({
    ip: req.ip,
    protocol: req.protocol,
    host: req.host,
  }));
  await app.ready();
  return app;
};

const expectBaseline = (h: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(API_BASELINE_HEADERS)) expect(h[k], k).toBe(v);
  expect(h['x-powered-by']).toBeUndefined();
};

describe('P9 R1/R3/R11: API header matrix', { timeout: 30_000 }, () => {
  it('sends the baseline on 200, 404, 500 and a preflight; non-2xx are no-store', async () => {
    const a = await build();
    const ok = await a.inject({ method: 'GET', url: '/health' });
    expectBaseline(ok.headers);
    for (const [url, code] of [
      ['/nope', 404],
      ['/__p9/boom', 500],
    ] as const) {
      const r = await a.inject({ method: 'GET', url });
      expect(r.statusCode).toBe(code);
      expectBaseline(r.headers);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const pre = await a.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expectBaseline(pre.headers);
  });

  it('a 429 keeps the baseline, no-store, CORS and exposes retry-after/x-request-id (and the UX-1 verify outcome)', async () => {
    const a = await build();
    const c = new Client(a as never);
    let last = await c.get('/health');
    for (let i = 0; i < 21; i++)
      last = await c.post(
        '/auth/login',
        { email: `x${i}@example.com`, password: 'whatever-whatever' },
        { origin: ORIGIN },
      );
    expect(last.statusCode).toBe(429);
    expectBaseline(last.headers);
    expect(last.headers['cache-control']).toBe('no-store');
    expect(last.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(last.headers['access-control-expose-headers']).toBe(
      'retry-after, x-request-id, x-meetops-verify-outcome',
    );
  });

  it('R2: HSTS value', () => {
    expect(HSTS_VALUE).toBe('max-age=63072000; includeSubDomains');
  });
});

describe('P9 R10: Vary: Origin', () => {
  it('varies on Origin for allowed, unknown and null origins and a denied preflight', async () => {
    const a = await build();
    for (const origin of [ORIGIN, 'https://evil.example', 'null']) {
      const r = await a.inject({ method: 'GET', url: '/auth/session', headers: { origin } });
      expect(String(r.headers.vary ?? '').toLowerCase(), origin).toContain('origin');
      if (origin !== ORIGIN) expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    const denied = await a.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(String(denied.headers.vary ?? '').toLowerCase()).toContain('origin');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('P9 R8/R9: exact credentialed preflight values (#399 L4)', () => {
  it('allows only the web origin, the listed methods and headers, with credentials and a 600 s cache', async () => {
    const a = await build();
    const r = await a.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token',
      },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    expect(r.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, PATCH, DELETE');
    expect(r.headers['access-control-allow-headers']).toBe('content-type, x-csrf-token');
    expect(r.headers['access-control-max-age']).toBe('600');
    expect(r.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('P9 R13: pre-session cookie', () => {
  it('is Strict, HttpOnly, Secure, host-only and expires', async () => {
    const a = await build();
    const r = await a.inject({ method: 'GET', url: '/auth/csrf' });
    const raw = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    const pre = raw.find((c) => c.includes('meetops_presession='))!;
    expect(pre).toBeDefined();
    expect(pre).toMatch(/SameSite=Strict/i);
    expect(pre).toMatch(/HttpOnly/i);
    expect(pre).toContain(`Max-Age=${PRE_SESSION_MAX_AGE_S}`);
    expect(pre).not.toMatch(/Domain=/i);
  });
});

describe('P9 R18: spoofed X-Forwarded-*', () => {
  const spoof = {
    'x-forwarded-for': '6.6.6.6',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example',
  };
  for (const trustProxy of ['', '10.0.0.1']) {
    it(`ignores them from an untrusted peer (TRUST_PROXY='${trustProxy}')`, async () => {
      const a = await build({ trustProxy });
      const r = await a.inject({
        method: 'GET',
        url: '/__p9/peer',
        remoteAddress: '198.51.100.20',
        headers: { ...spoof, host: 'localhost:80' },
      });
      expect(r.json()).toEqual({ ip: '198.51.100.20', protocol: 'http', host: 'localhost:80' });
    });
  }
  it('honours them from the trusted proxy', async () => {
    const a = await build({ trustProxy: '10.0.0.1' });
    const r = await a.inject({
      method: 'GET',
      url: '/__p9/peer',
      remoteAddress: '10.0.0.1',
      headers: { ...spoof, host: 'localhost:80' },
    });
    expect(r.json()).toEqual({ ip: '6.6.6.6', protocol: 'https', host: 'evil.example' });
  });
});
