import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository.js';
import {
  ARGON2_PARAMS,
  Argon2PasswordHasher,
} from '../src/modules/auth/infrastructure/argon2-password-hasher.js';
import {
  buildApp,
  Client,
  CSRF,
  ORIGIN,
  PASSWORD,
  SID,
  signupAndLogin,
  type App,
} from './helpers.js';

const MIN = 60_000;

describe('auth', () => {
  let app: App;
  let sessions: InMemorySessionRepository;
  let users: InMemoryUserRepository;

  beforeEach(async () => {
    sessions = new InMemorySessionRepository();
    users = new InMemoryUserRepository();
    app = await buildApp({ sessions, users });
  });
  afterEach(async () => app.close());

  describe('signup', () => {
    it('returns 202 and does not set a session', async () => {
      const c = new Client(app);
      const res = await c.post('/auth/signup', {
        name: 'Ada',
        email: 'Ada@Example.com',
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(202);
      expect(res.cookies.find((x) => x.name === SID)).toBeUndefined();
      expect((await users.findByEmail('ada@example.com'))?.name).toBe('Ada');
      expect(app.mail.sent.map((m) => m.template)).toEqual(['email_verification']);
    });

    it('is enumeration-safe for an existing email', async () => {
      const c = new Client(app);
      const a = await c.post('/auth/signup', {
        name: 'A',
        email: 'dup@example.com',
        password: PASSWORD,
      });
      const b = await c.post('/auth/signup', {
        name: 'B',
        email: 'DUP@example.com',
        password: 'another-password-1',
      });
      expect(b.statusCode).toBe(a.statusCode);
      expect(b.body).toBe(a.body);
      expect(app.mail.sent.map((m) => m.template)).toEqual([
        'email_verification',
        'account_exists',
      ]);
    });

    it.each([
      ['11 chars', 'a'.repeat(11)],
      ['129 chars', 'a'.repeat(129)],
    ])('rejects a %s password with 400 in the error envelope', async (_l, password) => {
      const res = await new Client(app).post('/auth/signup', {
        name: 'A',
        email: 'p@example.com',
        password,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });

    it.each([
      ['12 chars', 'a'.repeat(12)],
      ['128 chars', 'a'.repeat(128)],
    ])('accepts a %s password', async (_l, password) => {
      const res = await new Client(app).post('/auth/signup', {
        name: 'A',
        email: 'p@example.com',
        password,
      });
      expect(res.statusCode).toBe(202);
    });
  });

  describe('argon2id', () => {
    it('hashes with m=19456,t=2,p=1 and verifies', async () => {
      const h = new Argon2PasswordHasher();
      const hash = await h.hash(PASSWORD);
      expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await h.verify(hash, PASSWORD)).toBe(true);
      expect(await h.verify(hash, 'wrong')).toBe(false);
      expect(h.needsRehash(hash)).toBe(false);
    });
    it('rehashes outdated hashes on login', async () => {
      await app.close();
      const hasher = new Argon2PasswordHasher();
      app = await buildApp({ users, hasher });
      const weak = await new Argon2PasswordHasher({ ...ARGON2_PARAMS, memoryCost: 8192 }).hash(
        PASSWORD,
      );
      const now = new Date();
      await users.create({
        id: 'u1',
        email: 'old@example.com',
        name: null,
        passwordHash: weak,
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      const res = await new Client(app).post('/auth/login', {
        email: 'old@example.com',
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(200);
      expect((await users.findById('u1'))!.passwordHash).toMatch(/m=19456,t=2,p=1/);
    });
  });

  describe('login', () => {
    it('sets a __Host- session cookie with the required attributes and stores only a hash', async () => {
      const c = await signupAndLogin(app, 'login@example.com');
      const res = await c.post('/auth/login', { email: 'login@example.com', password: PASSWORD });
      const cookie = res.cookies.find((x) => x.name === SID)!;
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
      expect(cookie.domain).toBeUndefined();
      expect(cookie.maxAge).toBe(12 * 60 * 60);
      const stored = [...sessions.items.values()];
      expect(
        stored.every((s) => s.tokenHash !== cookie.value && /^[a-f0-9]{64}$/.test(s.tokenHash)),
      ).toBe(true);
      expect(res.body).not.toContain(cookie.value);
      expect(res.body).not.toMatch(/hash|"token"|accessToken|sessionToken/i);
      expect(res.json().csrfToken).toBeTypeOf('string');
    });

    it('rotates the session on login (old token revoked)', async () => {
      const c = await signupAndLogin(app, 'rot@example.com');
      const oldCookie = c.cookie;
      await c.post('/auth/login', { email: 'rot@example.com', password: PASSWORD });
      expect(c.cookie).not.toBe(oldCookie);
      const old = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: oldCookie },
      });
      expect(old.statusCode).toBe(401);
      expect((await c.get('/auth/session')).statusCode).toBe(200);
    });

    it('returns the same 401 for a wrong password and an unknown email', async () => {
      await signupAndLogin(app, 'login@example.com');
      const c = new Client(app);
      const wrong = await c.post('/auth/login', {
        email: 'login@example.com',
        password: 'nope-nope-nope',
      });
      const unknown = await c.post('/auth/login', {
        email: 'ghost@example.com',
        password: 'nope-nope-nope',
      });
      for (const r of [wrong, unknown]) {
        expect(r.statusCode).toBe(401);
        expect(r.json().error).toMatchObject({
          code: 'AUTH_FAILED',
          message: 'Invalid email or password',
        });
        expect(r.cookies.find((x) => x.name === SID)).toBeUndefined();
      }
    });

    it('locks the account after 10 failures and returns 429 with Retry-After', async () => {
      await signupAndLogin(app, 'lock@example.com');
      const c = new Client(app);
      for (let i = 0; i < 10; i++)
        await c.post('/auth/login', { email: 'lock@example.com', password: 'wrong-password' });
      const res = await c.post('/auth/login', { email: 'lock@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('rate-limits login per IP at 20/min', async () => {
      const c = new Client(app);
      let last = 0;
      for (let i = 0; i < 21; i++)
        last = (
          await c.post('/auth/login', { email: `x${i}@example.com`, password: 'whatever-whatever' })
        ).statusCode;
      expect(last).toBe(429);
    });
  });

  describe('session', () => {
    it('returns the user, orgs and timing, and 401 without/with a bogus cookie', async () => {
      const c = await signupAndLogin(app, 'me@example.com');
      const ok = await c.get('/auth/session');
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({
        user: { email: 'me@example.com', name: 'Test User' },
        organizations: [],
        activeOrganizationId: null,
      });
      expect(ok.body).not.toMatch(/passwordHash|tokenHash|accessToken/);
      expect((await app.inject({ method: 'GET', url: '/auth/session' })).statusCode).toBe(401);
      const bogus = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: `${SID}=bogus` },
      });
      expect(bogus.statusCode).toBe(401);
      expect(bogus.json().error.code).toBe('UNAUTHENTICATED');
    });

    it('expires after 30 minutes idle but slides with activity', async () => {
      let now = new Date('2026-01-01T00:00:00Z');
      await app.close();
      app = await buildApp({ clock: { now: () => now } });
      const c = await signupAndLogin(app, 'idle@example.com');
      now = new Date(now.getTime() + 29 * MIN);
      expect((await c.get('/auth/session')).statusCode).toBe(200);
      now = new Date(now.getTime() + 29 * MIN);
      expect((await c.get('/auth/session')).statusCode).toBe(200);
      now = new Date(now.getTime() + 31 * MIN);
      expect((await c.get('/auth/session')).statusCode).toBe(401);
    });

    it('expires after 12 hours absolute even when active', async () => {
      let now = new Date('2026-01-01T00:00:00Z');
      await app.close();
      app = await buildApp({ clock: { now: () => now } });
      const c = await signupAndLogin(app, 'abs@example.com');
      for (let i = 0; i < 25; i++) {
        now = new Date(now.getTime() + 29 * MIN);
        await c.get('/auth/session');
      }
      expect((await c.get('/auth/session')).statusCode).toBe(401);
    });
  });

  describe('logout', () => {
    it('revokes the session and clears the cookie', async () => {
      const c = await signupAndLogin(app, 'out@example.com');
      const sessionCookie = c.cookie;
      const res = await c.post('/auth/logout');
      expect(res.statusCode).toBe(204);
      expect(res.cookies.find((x) => x.name === SID)!.value).toBe('');
      const after = await app.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: sessionCookie },
      });
      expect(after.statusCode).toBe(401);
    });
  });

  describe('CSRF and Origin', () => {
    it('GET /auth/csrf returns a token and sets __Host-meetops_csrf (Secure, Path=/, SameSite=Lax)', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/csrf' });
      expect(res.statusCode).toBe(200);
      const cookie = res.cookies.find((x) => x.name === CSRF)!;
      expect(cookie).toMatchObject({
        secure: true,
        path: '/',
        sameSite: 'Lax',
        value: res.json().csrfToken,
      });
      expect(cookie.domain).toBeUndefined();
    });

    const body = { name: 'A', email: 'csrf@example.com', password: PASSWORD };
    it('403s a mutation with a missing token', async () => {
      const c = new Client(app);
      await c.csrf();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: body,
        headers: { cookie: c.cookie, origin: ORIGIN },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_INVALID');
    });
    it('403s a mutation with a mismatched token', async () => {
      const c = new Client(app);
      await c.csrf();
      const res = await c.post('/auth/signup', body, { 'x-csrf-token': 'not-the-cookie-value' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_INVALID');
      expect(res.json().error.requestId).toBeTruthy();
    });
    it('403s a mutation with a header but no cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: body,
        headers: { origin: ORIGIN, 'x-csrf-token': 'abc' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_INVALID');
    });
    it('succeeds with a matching token', async () => {
      expect((await new Client(app).post('/auth/signup', body)).statusCode).toBe(202);
    });
    it('403s a disallowed or missing Origin even with a valid token', async () => {
      const c = new Client(app);
      const evil = await c.post('/auth/signup', body, { origin: 'https://evil.example' });
      expect(evil.statusCode).toBe(403);
      // Origin failures stay FORBIDDEN (distinct from CSRF_INVALID)
      expect(evil.json().error.code).toBe('FORBIDDEN');
      const t = await c.csrf();
      const none = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: body,
        headers: { cookie: c.cookie, 'x-csrf-token': t },
      });
      expect(none.statusCode).toBe(403);
      expect(none.json().error.code).toBe('FORBIDDEN');
      const ref = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: body,
        headers: { cookie: c.cookie, 'x-csrf-token': t, referer: `${ORIGIN}/signup` },
      });
      expect(ref.statusCode).toBe(202);
    });
  });

  describe('password reset', () => {
    it('forgot-password is enumeration-safe and reset revokes all sessions', async () => {
      const c = await signupAndLogin(app, 'reset@example.com');
      const anon = new Client(app);
      const known = await anon.post('/auth/forgot-password', { email: 'reset@example.com' });
      const unknown = await anon.post('/auth/forgot-password', { email: 'nobody@example.com' });
      expect(known.statusCode).toBe(202);
      expect(unknown.body).toBe(known.body);
      const mail = app.mail.sent.filter((m) => m.template === 'password_reset');
      expect(mail).toHaveLength(1);

      const newPassword = 'a-brand-new-password';
      expect(
        (
          await anon.post('/auth/reset-password', {
            token: new URL(mail[0]!.data.url!).searchParams.get('token')!,
            password: newPassword,
          })
        ).statusCode,
      ).toBe(204);
      expect((await c.get('/auth/session')).statusCode).toBe(401);
      expect(
        (await anon.post('/auth/login', { email: 'reset@example.com', password: newPassword }))
          .statusCode,
      ).toBe(200);
      // single use
      const again = await anon.post('/auth/reset-password', {
        token: new URL(mail[0]!.data.url!).searchParams.get('token')!,
        password: newPassword,
      });
      expect(again.statusCode).toBe(400);
      expect(again.json().error.code).toBe('BAD_REQUEST');
    });

    it('rejects an expired reset token (30 min TTL)', async () => {
      let now = new Date('2026-01-01T00:00:00Z');
      await app.close();
      app = await buildApp({ clock: { now: () => now } });
      await signupAndLogin(app, 'exp@example.com');
      const anon = new Client(app);
      await anon.post('/auth/forgot-password', { email: 'exp@example.com' });
      const token = new URL(
        app.mail.sent.find((m) => m.template === 'password_reset')!.data.url!,
      ).searchParams.get('token')!;
      now = new Date(now.getTime() + 31 * MIN);
      expect(
        (await anon.post('/auth/reset-password', { token, password: 'a-brand-new-password' }))
          .statusCode,
      ).toBe(400);
    });
  });

  it('openapi response schemas never expose hashes or tokens (except /auth/csrf and extension token issuance)', async () => {
    const spec = app.swagger() as unknown as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    // ADR-005 A1: these two routes exist to hand the extension its opaque token pair (never a hash).
    const tokenIssuers = new Set<string>([
      EXTENSION_AUTH_PATHS.token,
      EXTENSION_AUTH_PATHS.refresh,
    ]);
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (path === '/auth/csrf') continue;
      if (tokenIssuers.has(path)) {
        expect(JSON.stringify(Object.values(ops).map((o) => o.responses)), path).not.toMatch(
          /"(passwordHash|tokenHash|sessionToken)"/,
        );
        continue;
      }
      const json = JSON.stringify(Object.values(ops).map((o) => o.responses));
      expect(json, path).not.toMatch(/"(passwordHash|tokenHash|token|accessToken|sessionToken)"/);
    }
  });
});

describe('contracts session shape', () => {
  it('login returns csrfToken and role; GET /auth/session omits csrfToken', async () => {
    const app = await buildApp();
    const c = await signupAndLogin(app, 'shape@example.com');
    await c.post('/orgs', { name: 'Shape' });
    const login = await c.post('/auth/login', { email: 'shape@example.com', password: PASSWORD });
    expect(login.json().csrfToken).toBe(c.jar.get(CSRF));
    expect(login.json()).toHaveProperty('role');
    const s = await c.get('/auth/session');
    expect(s.json()).not.toHaveProperty('csrfToken');
    await c.post('/orgs/switch', { organizationId: login.json().organizations[0].id });
    expect((await c.get('/auth/session')).json().role).toBe('owner');
    await app.close();
  });
});
