import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository';
import { buildApp, sessionCookie, signup, type App } from './helpers';

describe('auth routes', () => {
  let app: App;
  let sessions: InMemorySessionRepository;
  let users: InMemoryUserRepository;

  beforeEach(async () => {
    sessions = new InMemorySessionRepository();
    users = new InMemoryUserRepository();
    app = await buildApp({ sessions, users });
  });
  afterEach(async () => app.close());

  it('signs up, hashes the password with argon2id and sets a secure httpOnly cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'Ada@Example.com', password: 'correct-horse-battery', name: 'Ada' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe('ada@example.com');
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.session.activeOrganizationId).toBeNull();

    const cookie = res.cookies.find((c) => c.name === 'meetops_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.secure).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');

    const stored = await users.findByEmail('ada@example.com');
    expect(stored!.passwordHash.startsWith('$argon2id$')).toBe(true);
    const [session] = [...sessions.items.values()];
    expect(session!.tokenHash).not.toBe(cookie.value);
    expect(session!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a duplicate email (case-insensitive) with 409', async () => {
    await signup(app, 'dup@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'DUP@example.com', password: 'another-password' }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('validates the signup body', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'bad', password: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('logs in with correct credentials', async () => {
    await signup(app, 'login@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@example.com', password: 'correct-horse-battery' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('login@example.com');
    expect(() => sessionCookie(res)).not.toThrow();
  });

  it('fails login with wrong password or unknown email using the same error', async () => {
    await signup(app, 'login@example.com');
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'login@example.com', password: 'nope-nope-nope' }
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ghost@example.com', password: 'nope-nope-nope' }
    });
    for (const r of [wrong, unknown]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('INVALID_CREDENTIALS');
      expect(r.cookies.find((c) => c.name === 'meetops_session')).toBeUndefined();
    }
  });

  it('returns the session for a valid cookie and 401 without one', async () => {
    const { cookie } = await signup(app, 'me@example.com');
    const ok = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe('me@example.com');

    const none = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(none.statusCode).toBe(401);
    const bogus = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: 'meetops_session=bogus' } });
    expect(bogus.statusCode).toBe(401);
  });

  it('logs out: revokes the session and clears the cookie', async () => {
    const { cookie } = await signup(app, 'out@example.com');
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    const cleared = res.cookies.find((c) => c.name === 'meetops_session')!;
    expect(cleared.value).toBe('');
    const after = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(after.statusCode).toBe(401);
    // idempotent without a cookie
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(204);
  });

  it('rejects an expired session', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    await app.close();
    app = await buildApp({ clock: { now: () => now }, sessionTtlMs: 1000 });
    const { cookie } = await signup(app, 'exp@example.com');
    now = new Date(now.getTime() + 2000);
    const res = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});
