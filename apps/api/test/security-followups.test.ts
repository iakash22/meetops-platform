import Fastify from 'fastify';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope } from '@meetops/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { API_CSP, registerSecurityHeaders } from '../src/shared/security-headers.js';
import { registerDomainErrorHandler } from '../src/shared/http-errors.js';
import { InvalidWebOriginsError, parseWebOrigins } from '../src/shared/web-origins.js';
import { buildApp, Client, CSRF, ORIGIN, signupAndLogin, SID, type App } from './helpers.js';

const closers: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((a) => a.close()));
});

const LEAK = /stack|at \w+ \(|prisma|\/src\/|\/etc\//i;

describe('P9 R4: docs CSP relaxation and per-route overrides', () => {
  it('serves /docs with the strict API CSP unless docs are enabled', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { hsts: true, docs: false });
    app.get('/docs', async () => 'ui');
    closers.push(app);
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.headers['content-security-policy']).toBe(API_CSP);
  });

  it('reply.securityOverride replaces CSP/CORP for one route only', async () => {
    const app = Fastify();
    registerSecurityHeaders(app, { hsts: false });
    app.get('/page', async (_req, reply) =>
      reply
        .securityOverride({ csp: "default-src 'none'; form-action 'self'", corp: 'same-site' })
        .send('ok'),
    );
    app.get('/plain', async () => 'ok');
    closers.push(app);
    const page = await app.inject({ method: 'GET', url: '/page' });
    expect(page.headers['content-security-policy']).toBe("default-src 'none'; form-action 'self'");
    expect(page.headers['cross-origin-resource-policy']).toBe('same-site');
    const plain = await app.inject({ method: 'GET', url: '/plain' });
    expect(plain.headers['content-security-policy']).toBe(API_CSP);
  });
});

describe('P9 R5: error responses never leak internals', () => {
  let app: App;
  afterEach(async () => app?.close());

  it.each([
    ['malformed JSON', '{"name":', 'application/json', 400],
    ['non-JSON body (R16)', 'name=a', 'text/plain', 415],
    ['schema violation', JSON.stringify({ email: 1 }), 'application/json', 400],
    ['oversized body', JSON.stringify({ name: 'x'.repeat(2_000_000) }), 'application/json', 413],
  ])('%s → %i with the error envelope', async (_n, payload, type, status) => {
    app = await buildApp();
    const c = new Client(app);
    const token = await c.csrf();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload,
      headers: { 'content-type': type, cookie: c.cookie, origin: ORIGIN, 'x-csrf-token': token },
    });
    expect(res.statusCode).toBe(status);
    expect(Value.Check(ApiErrorEnvelope, res.json())).toBe(true);
    expect(res.body).not.toMatch(LEAK);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('an unexpected throw is a generic 500', async () => {
    const plain = Fastify({ logger: false });
    registerDomainErrorHandler(plain);
    plain.get('/boom', async () => {
      throw new Error('secret /etc/passwd at handler (/src/x.ts:1)');
    });
    closers.push(plain);
    const res = await plain.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(Value.Check(ApiErrorEnvelope, res.json())).toBe(true);
    expect(res.body).not.toMatch(LEAK);
    expect(res.body).not.toContain('secret');
  });
});

describe('P9 R7: WEB_ORIGINS is validated at boot', () => {
  it('accepts exact origins', () => {
    expect(
      parseWebOrigins('https://a.example, https://b.example:8443', { requireHttps: true }),
    ).toEqual(['https://a.example', 'https://b.example:8443']);
    expect(parseWebOrigins('http://localhost:5173', { requireHttps: false })).toEqual([
      'http://localhost:5173',
    ]);
  });

  it.each([
    '*',
    'null',
    'not a url',
    'ftp://a.example',
    'https://a.example/',
    'https://a.example/path',
    'https://u:p@a.example',
    'https://a.example?x=1',
  ])('rejects %s', (raw) => {
    expect(() => parseWebOrigins(raw, { requireHttps: false })).toThrow(InvalidWebOriginsError);
  });

  it('requires https in production', () => {
    expect(() => parseWebOrigins('http://app.example', { requireHttps: true })).toThrow(
      InvalidWebOriginsError,
    );
  });
});

describe('P9 R13/R14: CSRF and pre-session cookies', () => {
  it('logout clears the session, CSRF and pre-session cookies', async () => {
    const app = await buildApp();
    closers.push(app);
    const c = await signupAndLogin(app, 'r14@example.com');
    const res = await c.post('/auth/logout');
    expect(res.statusCode).toBeLessThan(300);
    const cleared = new Map(res.cookies.map((k) => [k.name, k]));
    for (const name of [SID, CSRF, '__Host-meetops_presession']) {
      const k = cleared.get(name);
      expect(k, name).toBeDefined();
      expect(k!.value === '' || (k!.expires?.getTime() ?? Infinity) <= Date.now()).toBe(true);
    }
    expect(cleared.get(CSRF)?.sameSite).toBe('Strict');
  });
});
