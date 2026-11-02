import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import {
  MissingProductionDependencyError,
  PRODUCTION_REQUIRED_DEPS,
} from '../src/modules/index.js';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import { systemClock } from '../src/shared/ports.js';
import { parseTrustProxy } from '../src/shared/trust-proxy.js';
import { Client, fakeHasher, ORIGIN } from './helpers.js';
import {
  API_CSP,
  DOCS_CSP,
  HSTS_VALUE,
  docsEnabledFromEnv,
} from '../src/shared/security-headers.js';

// '' disables the DATABASE_URL / REDIS_URL defaults, so these hold even where CI exports them.
const NO_INFRA = { databaseUrl: '', redisUrl: '' };

describe('B1: production refuses in-memory defaults', () => {
  it('throws listing every missing implementation', () => {
    try {
      createServer({ nodeEnv: 'production', ...NO_INFRA });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingProductionDependencyError);
      expect((err as MissingProductionDependencyError).missing).toEqual([
        ...PRODUCTION_REQUIRED_DEPS,
      ]);
    }
  });
  it('still throws when only some are injected', () => {
    expect(() =>
      createServer({
        nodeEnv: 'production',
        ...NO_INFRA,
        deps: { rateLimiter: new InMemoryRateLimiter(systemClock) },
      }),
    ).toThrow(/users, sessions/);
  });
  it('allows in-memory defaults outside production', async () => {
    const app = createServer({ nodeEnv: 'test' });
    await app.ready();
    await app.close();
  });
});

describe('B2: trustProxy and request.ip keyed rate limits', { timeout: 30_000 }, () => {
  let app: ReturnType<typeof createServer> | undefined;
  afterEach(async () => app?.close());

  it('parses TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('10.0.0.1, 10.1.0.0/16')).toEqual(['10.0.0.1', '10.1.0.0/16']);
    const hop = parseTrustProxy('1') as (a: string, h: number) => boolean;
    expect(hop('x', 0)).toBe(true);
    expect(hop('x', 1)).toBe(false);
    expect(() => parseTrustProxy('true')).toThrow();
  });

  const burst = async (a: ReturnType<typeof createServer>) => {
    const c = new Client(a as never);
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (
        await c.post(
          '/auth/login',
          { email: `x${i}@example.com`, password: 'whatever-whatever' },
          { 'x-forwarded-for': `203.0.113.${i}` },
        )
      ).statusCode;
    }
    return last;
  };

  it('ignores an untrusted X-Forwarded-For (still rate-limited by socket IP)', async () => {
    app = createServer({ deps: { hasher: fakeHasher }, trustProxy: '' });
    await app.ready();
    expect(await burst(app)).toBe(429);
  });

  it('honours X-Forwarded-For from a trusted proxy', async () => {
    app = createServer({ deps: { hasher: fakeHasher }, trustProxy: '127.0.0.1' });
    await app.ready();
    expect(await burst(app)).toBe(401);
  });
});

describe('D9: 4xx framework errors use the envelope with a generic message', () => {
  it('unknown route → 404 NOT_FOUND', async () => {
    const app = createServer();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'NOT_FOUND', message: 'Not found' });
    expect(res.json().error.requestId).toBeTruthy();
    await app.close();
  });
  it('malformed JSON → 400 generic, no parser internals', async () => {
    const app = createServer();
    const c = new Client(app as never);
    const t = await c.csrf();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: '{"email":',
      headers: {
        'content-type': 'application/json',
        cookie: c.cookie,
        origin: ORIGIN,
        'x-csrf-token': t,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'BAD_REQUEST', message: 'Bad request' });
    expect(res.body).not.toMatch(/Unexpected|JSON|position/);
    await app.close();
  });
  it('oversized body → 413 with generic message', async () => {
    const app = createServer();
    const c = new Client(app as never);
    const t = await c.csrf();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(1_100_000) }),
      headers: {
        'content-type': 'application/json',
        cookie: c.cookie,
        origin: ORIGIN,
        'x-csrf-token': t,
      },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'BAD_REQUEST', message: 'Bad request' });
    await app.close();
  });
  it('validation errors carry paths but not validator messages', async () => {
    const app = createServer();
    const res = await new Client(app as never).post('/auth/signup', {
      name: 'A',
      email: 'a@example.com',
      password: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.body).not.toMatch(/must NOT have fewer/);
    await app.close();
  });
});

describe('CSRF HMAC binding', () => {
  it('a token from one session is rejected for another session (403)', async () => {
    const { buildApp, signupAndLogin } = await import('./helpers.js');
    const app = await buildApp();
    const a = await signupAndLogin(app, 'a@example.com');
    const b = await signupAndLogin(app, 'b@example.com');
    const tokenA = a.jar.get('__Host-meetops_csrf')!;
    b.jar.set('__Host-meetops_csrf', tokenA);
    const res = await b.post('/orgs', { name: 'X' }, { 'x-csrf-token': tokenA });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_INVALID');
    expect((await a.post('/orgs', { name: 'X' })).statusCode).toBe(201);
    await app.close();
  });

  it('a pre-session token stops working once a session exists; login returns a fresh one', async () => {
    const { buildApp, Client, PASSWORD } = await import('./helpers.js');
    const app = await buildApp();
    const c = new Client(app);
    const pre = await c.csrf();
    expect(c.jar.has('__Host-meetops_presession')).toBe(true);
    await c.post('/auth/signup', { name: 'A', email: 'p@example.com', password: PASSWORD });
    await c.post('/auth/verify-email', {
      token: app.token('p@example.com', 'email_verification')!,
    });
    const login = await c.post('/auth/login', { email: 'p@example.com', password: PASSWORD });
    expect(login.json().csrfToken).not.toBe(pre);
    const stale = await c.post('/orgs', { name: 'X' }, { 'x-csrf-token': pre });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('CSRF_INVALID');
    expect((await c.post('/orgs', { name: 'X' })).statusCode).toBe(201);
    await app.close();
  });

  it('a forged token (valid shape, wrong MAC) matching the cookie is rejected', async () => {
    const { buildApp, Client, ORIGIN } = await import('./helpers.js');
    const app = await buildApp();
    const c = new Client(app);
    await c.csrf();
    const forged = 'abc.def';
    c.jar.set('__Host-meetops_csrf', forged);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'a@example.com' },
      headers: { cookie: c.cookie, origin: ORIGIN, 'x-csrf-token': forged },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_INVALID');
    await app.close();
  });
});

describe('cookie policy', () => {
  it('development drops the __Host- prefix and Secure', async () => {
    const { cookieConfig } = await import('../src/modules/auth/http/security.js');
    expect(cookieConfig('development')).toMatchObject({
      cookieName: 'meetops_sid',
      csrfCookieName: 'meetops_csrf',
      cookieSecure: false,
    });
    expect(cookieConfig('production')).toMatchObject({
      cookieName: '__Host-meetops_sid',
      csrfCookieName: '__Host-meetops_csrf',
      cookieSecure: true,
    });
    expect(cookieConfig('test').cookieName).toBe('__Host-meetops_sid');
  });
  it('production refuses non-__Host- or non-Secure cookie config', async () => {
    const { assertProductionCookies, cookieConfig } =
      await import('../src/modules/auth/http/security.js');
    const base = {
      allowedOrigins: ['https://app.example'],
      sessionPolicy: { idleTimeoutMs: 1, absoluteTimeoutMs: 1 },
      csrfSecret: Buffer.alloc(32, 1),
    };
    expect(() => assertProductionCookies({ ...cookieConfig('production'), ...base })).not.toThrow();
    expect(() => assertProductionCookies({ ...cookieConfig('development'), ...base })).toThrow(
      /__Host-/,
    );
    expect(() =>
      assertProductionCookies({ ...cookieConfig('production'), cookieSecure: false, ...base }),
    ).toThrow();
    expect(() =>
      assertProductionCookies({
        ...cookieConfig('production'),
        ...base,
        csrfSecret: Buffer.alloc(8),
      }),
    ).toThrow(/CSRF_SECRET/);
  });
  it('production requires WEB_ORIGINS and CSRF_SECRET when security is not injected', async () => {
    const { defaultModuleDeps, PRODUCTION_REQUIRED_DEPS } = await import('../src/modules/index.js');
    const all: Record<string, object> = {};
    for (const k of PRODUCTION_REQUIRED_DEPS as readonly string[]) all[k] = {};
    const saved = { o: process.env.WEB_ORIGINS, s: process.env.CSRF_SECRET };
    delete process.env.WEB_ORIGINS;
    delete process.env.CSRF_SECRET;
    expect(() => defaultModuleDeps(all, { nodeEnv: 'production' })).toThrow(
      /WEB_ORIGINS, CSRF_SECRET/,
    );
    process.env.WEB_ORIGINS = 'https://app.example';
    process.env.CSRF_SECRET = 'x'.repeat(40);
    const deps = defaultModuleDeps(all, { nodeEnv: 'production' });
    expect(deps.security).toMatchObject({
      cookieName: '__Host-meetops_sid',
      cookieSecure: true,
      allowedOrigins: ['https://app.example'],
    });
    if (saved.o === undefined) delete process.env.WEB_ORIGINS;
    else process.env.WEB_ORIGINS = saved.o;
    if (saved.s === undefined) delete process.env.CSRF_SECRET;
    else process.env.CSRF_SECRET = saved.s;
  });
  it('dev default origins include the Vite app', async () => {
    const { DEV_WEB_ORIGINS } = await import('../src/modules/auth/http/security.js');
    expect(DEV_WEB_ORIGINS).toContain('http://localhost:5173');
  });
});

describe('B1 fail-closed for every NODE_ENV except development/test', () => {
  it.each([[undefined], ['staging'], ['production'], ['prod'], ['']])(
    'NODE_ENV=%s refuses in-memory defaults',
    async (nodeEnv) => {
      const { defaultModuleDeps, isRelaxedEnv } = await import('../src/modules/index.js');
      expect(isRelaxedEnv(nodeEnv)).toBe(false);
      expect(() => defaultModuleDeps({}, { nodeEnv })).toThrow(/Refusing to start/);
    },
  );
  it('NODE_ENV unset runs the full checks (missing WEB_ORIGINS / CSRF_SECRET)', async () => {
    const { defaultModuleDeps, PRODUCTION_REQUIRED_DEPS } = await import('../src/modules/index.js');
    const all: Record<string, object> = {};
    for (const k of PRODUCTION_REQUIRED_DEPS as readonly string[]) all[k] = {};
    const saved = { o: process.env.WEB_ORIGINS, s: process.env.CSRF_SECRET };
    delete process.env.WEB_ORIGINS;
    delete process.env.CSRF_SECRET;
    try {
      expect(() => defaultModuleDeps(all, { nodeEnv: undefined })).toThrow(
        /WEB_ORIGINS, CSRF_SECRET/,
      );
      expect(() => defaultModuleDeps(all, { nodeEnv: 'staging' })).toThrow(
        /WEB_ORIGINS, CSRF_SECRET/,
      );
    } finally {
      if (saved.o !== undefined) process.env.WEB_ORIGINS = saved.o;
      if (saved.s !== undefined) process.env.CSRF_SECRET = saved.s;
    }
  });
  it('createServer with NODE_ENV unset refuses to start', () => {
    expect(() => createServer({ nodeEnv: '', ...NO_INFRA })).toThrow(/Refusing to start/);
  });
  it('the test runner runs with NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
  it('development and test are relaxed', async () => {
    const { isRelaxedEnv } = await import('../src/modules/index.js');
    expect(isRelaxedEnv('development')).toBe(true);
    expect(isRelaxedEnv('test')).toBe(true);
    expect(isRelaxedEnv('Development')).toBe(false);
  });
});

describe('TRUST_PROXY validation', () => {
  it('accepts valid IPs and CIDRs', () => {
    expect(parseTrustProxy('10.0.0.1,10.0.0.0/8,::1,fd00::/8')).toEqual([
      '10.0.0.1',
      '10.0.0.0/8',
      '::1',
      'fd00::/8',
    ]);
  });
  it.each([
    '0.0.0.0/0',
    '::/0',
    '::0/0',
    '10.0.0.0/0',
    '0:0:0:0:0:0:0:0/0',
    '10.0.0.0/00',
    '10.0.0.256',
    'loopback',
    '10.0.0.0/33',
    '::1/129',
    '10.0.0.1/',
    '10.0.0.0/8/1',
    '10.0.0.1, nope',
  ])('rejects %s at startup', (v) => {
    expect(() => parseTrustProxy(v)).toThrow(/invalid IP\/CIDR/);
    expect(() => createServer({ trustProxy: v })).toThrow(/invalid IP\/CIDR/);
  });
});

describe('log redaction', () => {
  it('redacts x-csrf-token, cookie and authorization headers', async () => {
    const { REDACT_PATHS } = await import('../src/server.js');
    for (const p of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
    ]) {
      expect(REDACT_PATHS).toContain(p);
    }
    const pino = (await import('pino')).default;
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: REDACT_PATHS, censor: '***redacted***' } },
      { write: (l: string) => void lines.push(l) },
    );
    log.info(
      {
        req: {
          headers: {
            'x-csrf-token': 'SECRET1',
            cookie: 'sid=SECRET2',
            authorization: 'Bearer SECRET3',
          },
        },
      },
      'x',
    );
    expect(lines.join('')).not.toMatch(/SECRET[123]/);
    expect(lines.join('')).toContain('***redacted***');
  });
});

describe('Swagger UI gate', () => {
  it('docsEnabledFromEnv: dev/test on; elsewhere only an explicit API_DOCS_ENABLED=true', () => {
    expect(docsEnabledFromEnv('development', undefined)).toBe(true);
    expect(docsEnabledFromEnv('test', 'false')).toBe(true);
    for (const env of ['production', 'staging', '', undefined]) {
      expect(docsEnabledFromEnv(env, undefined)).toBe(false);
      for (const v of ['', 'false', '0', '1', 'yes', 'on', 'enabled'])
        expect(docsEnabledFromEnv(env, v)).toBe(false);
      expect(docsEnabledFromEnv(env, 'true')).toBe(true);
      expect(docsEnabledFromEnv(env, ' TRUE ')).toBe(true);
    }
  });
  const serverFor = async (nodeEnv: string, docsEnabled = '') => {
    const { defaultModuleDeps } = await import('../src/modules/index.js');
    // Fully injected deps so strict envs can start; only the docs gate is under test.
    const deps = defaultModuleDeps({}, { nodeEnv: 'test' });
    const app = createServer({ nodeEnv, deps, docsEnabled });
    await app.ready();
    return app;
  };
  it.each(['false', '1', 'yes', ''])(
    'production keeps /docs off for API_DOCS_ENABLED=%j',
    async (flag) => {
      const app = await serverFor('production', flag);
      for (const url of ['/docs', '/docs/json'])
        expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
      await app.close();
    },
  );
  it('production serves /docs with the strict DOCS_CSP only when API_DOCS_ENABLED=true', async () => {
    const app = await serverFor('production', 'true');
    for (const url of ['/docs/json', '/docs/', '/docs/static/swagger-initializer.js']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      const csp = r.headers['content-security-policy'];
      expect(csp, url).toBe(DOCS_CSP);
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:|\*/);
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['strict-transport-security']).toBe(HSTS_VALUE);
    }
    // The UI page loads only external same-origin scripts, so script-src 'self' (no inline) is enough.
    const html = (await app.inject({ method: 'GET', url: '/docs/' })).body;
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    // Non-docs routes keep the JSON API CSP.
    expect(
      (await app.inject({ method: 'GET', url: '/health' })).headers['content-security-policy'],
    ).toBe(API_CSP);
    await app.close();
  });
  it.each(['production', 'staging', ''])(
    '/docs and /docs/json are 404 when NODE_ENV=%s',
    async (env) => {
      const app = await serverFor(env);
      for (const url of ['/docs', '/docs/', '/docs/json', '/docs/yaml']) {
        const r = await app.inject({ method: 'GET', url });
        expect(r.statusCode, url).toBe(404);
        expect(r.json().error.code).toBe('NOT_FOUND');
      }
      await app.close();
    },
  );
  it.each(['development', 'test'])('/docs is served when NODE_ENV=%s', async (env) => {
    const app = await serverFor(env);
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
    const ui = await app.inject({ method: 'GET', url: '/docs' });
    expect([200, 302]).toContain(ui.statusCode);
    expect(ui.headers['content-security-policy']).toBe(DOCS_CSP);
    await app.close();
  });
});
