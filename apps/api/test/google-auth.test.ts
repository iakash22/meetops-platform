import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleTokenError } from '../src/modules/auth/application/google-oidc.js';
import type { GoogleOAuthClient } from '../src/modules/auth/application/google-oauth.js';
import type { GoogleIdentity } from '../src/modules/auth/application/google-oidc.js';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository.js';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryMembershipRepository } from '../src/modules/organizations/infrastructure/in-memory.repositories.js';
import {
  AuthService,
  AUTH_LIMITS,
  type AuthServiceDeps,
} from '../src/modules/auth/application/auth.service.js';
import { RateLimiterUnavailableError } from '../src/shared/rate-limit-core.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, Client, PASSWORD, SID, signupAndLogin, type App } from './helpers.js';

const CONFIG = {
  clientId: '1234567890-abc.apps.googleusercontent.com',
  clientSecret: 'test-secret-value',
  redirectUri: 'http://localhost:5173/api/auth/google/callback',
};
const LINK_COOKIE = '__Host-meetops_oauth_link';
const VERIFY_LINK_COOKIE = '__Host-meetops_oauth_vlink';
const SIGNUP_COOKIE = '__Host-meetops_sid_signup';
/** A second valid password for the mailbox owner (derived, so no literal credential in the test). */
const OWNER_PASSWORD = `${PASSWORD}-owner`;

type Calls = { exchange: number };

function fakeClient(
  identity: () => GoogleIdentity,
  calls: Calls = { exchange: 0 },
): GoogleOAuthClient {
  return {
    async exchangeCode({ code, codeVerifier, config }) {
      calls.exchange++;
      if (code !== 'good-code' || codeVerifier.length < 43) throw new GoogleTokenError();
      if (config.clientSecret !== CONFIG.clientSecret) throw new GoogleTokenError();
      return 'fake-id-token';
    },
    async verifyIdToken(_idToken, expected) {
      if (expected.audience !== CONFIG.clientId || expected.nonce.length < 32) {
        throw new GoogleTokenError();
      }
      return identity();
    },
  };
}

async function appFor(
  identity: GoogleIdentity | (() => GoogleIdentity),
  deps: Partial<ModuleDeps> = {},
) {
  const users = (deps.users as InMemoryUserRepository | undefined) ?? new InMemoryUserRepository();
  const sessions =
    (deps.sessions as InMemorySessionRepository | undefined) ?? new InMemorySessionRepository();
  const audit = (deps.audit as InMemoryAuditLog | undefined) ?? new InMemoryAuditLog();
  const calls: Calls = { exchange: 0 };
  const who = typeof identity === 'function' ? identity : () => identity;
  const app = await buildApp({
    ...deps,
    users,
    sessions,
    audit,
    googleOAuth: { config: CONFIG, client: fakeClient(who, calls) },
  });
  return { app, users, sessions, audit, calls };
}

function oauthCookie(res: {
  cookies: { name: string; value: string; httpOnly?: boolean; sameSite?: string }[];
}) {
  const cookie = res.cookies.find((c) => c.name.endsWith('meetops_oauth'));
  if (!cookie) throw new Error('missing oauth cookie');
  return cookie;
}

async function start(app: App, next?: string) {
  const url = next ? `/auth/google/start?next=${encodeURIComponent(next)}` : '/auth/google/start';
  const res = await app.inject({ method: 'GET', url });
  const location = String(res.headers.location);
  const state = new URL(location).searchParams.get('state');
  return { res, location, state, cookie: oauthCookie(res) };
}

async function callback(
  app: App,
  cookie: { name: string; value: string } | null,
  state: string | null,
  opts: { code?: string; error?: string; extraCookie?: string } = {},
) {
  const q = new URLSearchParams();
  const code = opts.code ?? 'good-code';
  if (code && !opts.error) q.set('code', code);
  if (opts.error) q.set('error', opts.error);
  if (state) q.set('state', state);
  q.set('scope', 'openid email profile');
  const cookies = [cookie ? `${cookie.name}=${cookie.value}` : '', opts.extraCookie ?? '']
    .filter(Boolean)
    .join('; ');
  return app.inject({
    method: 'GET',
    url: `/auth/google/callback?${q.toString()}`,
    headers: cookies ? { cookie: cookies } : {},
  });
}

/** Full Google round trip into a cookie-jar client (like a browser). */
async function googleSignIn(app: App, browser = new Client(app), next?: string) {
  const begun = await start(app, next);
  const done = await app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=good-code&state=${encodeURIComponent(begun.state!)}`,
    headers: {
      cookie: [browser.cookie, `${begun.cookie.name}=${begun.cookie.value}`]
        .filter(Boolean)
        .join('; '),
    },
  });
  browser.absorb(done);
  return { browser, done };
}

const sessionOk = async (c: Client) => (await c.get('/auth/session')).statusCode;
const actions = (audit: InMemoryAuditLog) => audit.events.map((e) => e.action);

describe('google sign-in', () => {
  const ada: GoogleIdentity = {
    sub: '109876543210',
    email: 'Ada@Gmail.com',
    emailVerified: true,
    name: 'Ada Lovelace',
    hd: null,
  };
  const adaWork: GoogleIdentity = {
    sub: '209876543210',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada Lovelace',
    hd: null,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hides the provider when it is not configured', async () => {
    const app = await buildApp();
    const providers = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(providers.json()).toEqual({ google: false });
    expect((await app.inject({ method: 'GET', url: '/auth/google/start' })).statusCode).toBe(404);
    await app.close();
  });

  it('creates a verified account for a gmail address, with a google session, and signs in again', async () => {
    const { app, users, sessions } = await appFor(ada);
    const providers = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(providers.json()).toEqual({ google: true });

    const begun = await start(app, '/meetings');
    expect(begun.res.statusCode).toBe(302);
    const authorize = new URL(begun.location);
    expect(authorize.origin).toBe('https://accounts.google.com');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(authorize.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(begun.location).not.toContain(CONFIG.clientSecret);
    expect(begun.location).not.toContain('offline');
    expect(begun.cookie.httpOnly).toBe(true);
    expect(begun.cookie.sameSite).toBe('Lax');

    const done = await callback(app, begun.cookie, begun.state);
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe('http://localhost:5173/meetings');
    expect(String(done.headers.location)).not.toContain('good-code');
    expect(String(done.headers.location)).not.toContain('fake-id-token');
    expect(done.cookies.some((c) => c.name === SID && c.httpOnly)).toBe(true);

    const user = await users.findByEmail('ada@gmail.com');
    expect(user?.googleSub).toBe(ada.sub);
    expect(user?.emailVerifiedAt).toBeTruthy();
    expect(user?.passwordHash).toBe('');
    expect(user?.name).toBe('Ada Lovelace');
    // N-4: not the `password` column default.
    expect([...sessions.items.values()].map((s) => s.authLevel)).toEqual(['google']);

    const browser = new Client(app);
    browser.absorb(done);
    expect(await sessionOk(new Client(app))).toBe(401);
    expect(await sessionOk(browser)).toBe(200);

    const again = await start(app);
    const second = await callback(app, again.cookie, again.state);
    expect(second.headers.location).toBe('http://localhost:5173/');
    expect(await users.findByGoogleSub(ada.sub)).toMatchObject({ id: user?.id });
    await app.close();
  });

  it('M-2 / N-2: an address Google does not host makes an unverified account that cannot accept invitations', async () => {
    const { app, users } = await appFor(adaWork);
    const { browser, done } = await googleSignIn(app);
    expect(done.headers.location).toBe('http://localhost:5173/');
    const user = await users.findByEmail('ada@example.com');
    // N-7: the unproven subject is not linked yet; it waits in this browser for the verification link.
    expect(user?.googleSub ?? null).toBeNull();
    expect(user?.emailVerifiedAt).toBeNull();
    const vlink = done.cookies.find((c) => c.name === VERIFY_LINK_COOKIE);
    expect(vlink?.httpOnly).toBe(true);
    expect(vlink?.sameSite).toBe('Lax');
    // A verification link goes out so the owner can still prove the address.
    expect(app.token('ada@example.com', 'email_verification')).toBeTruthy();
    const accept = await browser.post('/invitations/accept', { token: 'x'.repeat(43) });
    expect(accept.statusCode).toBe(403);
    expect(JSON.stringify(accept.json())).toMatch(/Verify your email/);

    // Opened in this same Google session, the verification link proves the mailbox AND links the subject.
    const v = await browser.post('/auth/verify-email', {
      token: app.token('ada@example.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    const after = await users.findByEmail('ada@example.com');
    expect(after?.googleSub).toBe(adaWork.sub);
    expect(after?.emailVerifiedAt).toBeTruthy();
    expect(await sessionOk(browser)).toBe(200);
    expect(app.mail.sent.filter((m) => m.template === 'account_linked')).toHaveLength(1);
    const { done: again } = await googleSignIn(app);
    expect(again.headers.location).toBe('http://localhost:5173/');
    await app.close();
  });

  it('N-2: a Workspace account is verified only when hd equals the email domain', async () => {
    let id: GoogleIdentity = { ...adaWork, hd: 'example.com' };
    const { app, users } = await appFor(() => id);
    await googleSignIn(app);
    expect((await users.findByEmail('ada@example.com'))?.emailVerifiedAt).toBeTruthy();

    id = {
      sub: '309876543210',
      email: 'bob@example.org',
      emailVerified: true,
      name: 'Bob',
      hd: 'example.com',
    };
    await googleSignIn(app);
    expect((await users.findByEmail('bob@example.org'))?.emailVerifiedAt).toBeNull();
    await app.close();
  });

  it('N-1: Google proving the address of a pre-registered account locks the squatter out', async () => {
    const { app, users, audit } = await appFor(ada);
    // Attacker registers the victim's gmail address with their own password and never verifies it.
    const attacker = new Client(app);
    expect(
      (
        await attacker.post('/auth/signup', {
          name: 'Mallory',
          email: 'ada@gmail.com',
          password: PASSWORD,
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (await attacker.post('/auth/login', { email: 'ada@gmail.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    expect(await sessionOk(attacker)).toBe(200);
    const staleVerify = app.token('ada@gmail.com', 'email_verification')!;

    const { browser: victim, done } = await googleSignIn(app);
    expect(done.headers.location).toBe('http://localhost:5173/');
    expect(await sessionOk(victim)).toBe(200);

    // The attacker's session and password are gone, and their old verification link is dead.
    expect(await sessionOk(attacker)).toBe(401);
    const relogin = await new Client(app).post('/auth/login', {
      email: 'ada@gmail.com',
      password: PASSWORD,
    });
    expect(relogin.statusCode).toBe(401);
    expect(
      (await new Client(app).post('/auth/verify-email', { token: staleVerify })).statusCode,
    ).toBe(400);

    const user = await users.findByEmail('ada@gmail.com');
    expect(user?.googleSub).toBe(ada.sub);
    expect(user?.emailVerifiedAt).toBeTruthy();
    expect(user?.passwordHash).toBe('');
    const linked = audit.events.find((e) => e.action === 'auth.google.linked');
    expect(linked?.metadata).toMatchObject({
      provider: 'google',
      method: 'google_proven_unverified_local',
    });
    expect(app.mail.sent.filter((m) => m.template === 'account_linked').map((m) => m.to)).toEqual([
      'ada@gmail.com',
    ]);
    await app.close();
  });

  it('M-2: links a proven address onto a verified account and signs out its other sessions', async () => {
    const { app, users, audit } = await appFor(ada);
    const laptop = await signupAndLogin(app, 'ada@gmail.com');
    const phone = new Client(app);
    expect(
      (await phone.post('/auth/login', { email: 'ada@gmail.com', password: PASSWORD })).statusCode,
    ).toBe(200);

    const { browser, done } = await googleSignIn(
      app,
      new Client(app),
      'https://evil.example/phish',
    );
    expect(done.headers.location).toBe('http://localhost:5173/');
    expect(String(done.headers.location)).not.toContain('evil.example');
    expect((await users.findByEmail('ada@gmail.com'))?.googleSub).toBe(ada.sub);
    expect(await sessionOk(browser)).toBe(200);
    expect(await sessionOk(laptop)).toBe(401);
    expect(await sessionOk(phone)).toBe(401);
    // Verified from the browser that registered it (signupAndLogin), so the password is the owner's and stays.
    expect(
      (await new Client(app).post('/auth/login', { email: 'ada@gmail.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    expect(actions(audit)).toContain('auth.google.linked');
    expect(app.mail.sent.some((m) => m.template === 'account_linked')).toBe(true);
    await app.close();
  });

  it('M-2: an unproven address needs the account password before it is linked', async () => {
    const { app, users, audit } = await appFor(adaWork);
    const other = await signupAndLogin(app, 'ada@example.com');
    await signupAndLogin(app, 'eve@example.com');

    const browser = new Client(app);
    const { done } = await googleSignIn(app, browser, '/meetings');
    expect(done.headers.location).toBe(
      'http://localhost:5173/login?error=google_link_password&next=%2Fmeetings',
    );
    expect(done.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    const pending = done.cookies.find((c) => c.name === LINK_COOKIE);
    expect(pending?.httpOnly).toBe(true);
    expect(pending?.sameSite).toBe('Lax');
    expect((await users.findByEmail('ada@example.com'))?.googleSub ?? null).toBeNull();
    expect(actions(audit)).not.toContain('auth.google.linked');

    // A different account's password does not consume the pending link.
    const wrongAccount = new Client(app);
    wrongAccount.jar.set(LINK_COOKIE, pending!.value);
    expect(
      (await wrongAccount.post('/auth/login', { email: 'eve@example.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    expect((await users.findByEmail('eve@example.com'))?.googleSub ?? null).toBeNull();
    expect((await users.findByEmail('ada@example.com'))?.googleSub ?? null).toBeNull();

    // A tampered cookie is ignored.
    const tampered = new Client(app);
    tampered.jar.set(LINK_COOKIE, `${pending!.value}x`);
    expect(
      (await tampered.post('/auth/login', { email: 'ada@example.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    expect((await users.findByEmail('ada@example.com'))?.googleSub ?? null).toBeNull();

    // The owner's password in the same browser completes the link.
    const login = await browser.post('/auth/login', {
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(login.statusCode).toBe(200);
    expect(login.cookies.find((c) => c.name === LINK_COOKIE)?.value).toBe('');
    expect((await users.findByEmail('ada@example.com'))?.googleSub).toBe(adaWork.sub);
    expect(await sessionOk(browser)).toBe(200);
    expect(await sessionOk(other)).toBe(401);
    expect(await sessionOk(tampered)).toBe(401);
    const linked = audit.events.find((e) => e.action === 'auth.google.linked');
    expect(linked?.metadata).toMatchObject({ method: 'password' });
    expect(app.mail.sent.filter((m) => m.template === 'account_linked')).toHaveLength(1);

    // Next time Google signs straight in by subject.
    const { done: again } = await googleSignIn(app);
    expect(again.headers.location).toBe('http://localhost:5173/');
    await app.close();
  });

  it('does not link an unproven Google identity onto an unverified password account', async () => {
    const { app, users } = await appFor(adaWork);
    const signup = await new Client(app).post('/auth/signup', {
      name: 'Ada',
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(signup.statusCode).toBe(202);
    const begun = await start(app, '/meetings');
    const done = await callback(app, begun.cookie, begun.state);
    expect(String(done.headers.location)).toBe(
      'http://localhost:5173/login?error=google_unverified&next=%2Fmeetings',
    );
    expect(done.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    expect(done.cookies.some((c) => c.name === LINK_COOKIE)).toBe(false);
    expect((await users.findByEmail('ada@example.com'))?.googleSub ?? null).toBeNull();
    await app.close();
  });

  it('refuses an account already bound to a different Google subject', async () => {
    const users = new InMemoryUserRepository();
    const now = new Date();
    await users.create({
      id: '00000000-0000-4000-8000-000000000001',
      email: 'ada@gmail.com',
      name: 'Ada',
      passwordHash: '',
      emailVerifiedAt: now,
      googleSub: 'someone-else',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    const { app, audit } = await appFor(ada, { users });
    const { done } = await googleSignIn(app);
    expect(String(done.headers.location)).toBe('http://localhost:5173/login?error=google');
    expect((await users.findByEmail('ada@gmail.com'))?.googleSub).toBe('someone-else');
    expect(audit.events.find((e) => e.action === 'auth.login.failure')?.metadata).toMatchObject({
      reason: 'conflict',
    });
    await app.close();
  });

  it('L-1: a soft-deleted user does not keep its Google subject', async () => {
    const users = new InMemoryUserRepository();
    const then = new Date('2026-01-01T00:00:00.000Z');
    await users.create({
      id: '00000000-0000-4000-8000-000000000002',
      email: 'old@example.com',
      name: 'Old',
      passwordHash: '',
      emailVerifiedAt: then,
      googleSub: ada.sub,
      createdAt: then,
      updatedAt: then,
      deletedAt: then,
    });
    const { app } = await appFor(ada, { users });
    const { done } = await googleSignIn(app);
    expect(done.headers.location).toBe('http://localhost:5173/');
    const fresh = await users.findByGoogleSub(ada.sub);
    expect(fresh?.email).toBe('ada@gmail.com');
    expect(fresh?.id).not.toBe('00000000-0000-4000-8000-000000000002');
    await app.close();
  });

  it('revokes the session presented to the callback', async () => {
    const { app } = await appFor(ada);
    const browser = await signupAndLogin(app, 'someone@example.com');
    const before = browser.jar.get(SID);
    const stale = new Client(app);
    stale.jar.set(SID, before!);
    await googleSignIn(app, browser);
    expect(browser.jar.get(SID)).not.toBe(before);
    expect(await sessionOk(stale)).toBe(401);
    expect(await sessionOk(browser)).toBe(200);
    await app.close();
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const { app, calls } = await appFor(ada);
    const begun = await start(app);
    const done = await callback(app, begun.cookie, 'not-the-state');
    expect(String(done.headers.location)).toContain('error=google');
    expect(String(done.headers.location)).not.toContain('google_unverified');
    expect(done.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    expect(calls.exchange).toBe(0);
    await app.close();
  });

  it('?error=access_denied, a missing code, or a missing cookie never reach Google', async () => {
    const { app, calls } = await appFor(ada);
    const begun = await start(app, '/meetings');
    const denied = await callback(app, begun.cookie, begun.state, { error: 'access_denied' });
    expect(denied.headers.location).toBe(
      'http://localhost:5173/login?error=google&next=%2Fmeetings',
    );
    const other = await start(app);
    const noCode = await callback(app, other.cookie, other.state, { code: '' });
    expect(String(noCode.headers.location)).toContain('error=google');
    const third = await start(app);
    const noCookie = await callback(app, null, third.state);
    expect(noCookie.headers.location).toBe('http://localhost:5173/login?error=google');
    expect(calls.exchange).toBe(0);
    await app.close();
  });

  it('refuses an expired state cookie', async () => {
    const { app, calls } = await appFor(ada);
    const begun = await start(app);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60 * 1000 });
    const done = await callback(app, begun.cookie, begun.state);
    expect(String(done.headers.location)).toContain('error=google');
    expect(calls.exchange).toBe(0);
    await app.close();
  });

  it('N-3 / N-6: each state completes one callback; replays are refused', async () => {
    const { app, calls } = await appFor(ada);
    const begun = await start(app);
    expect((await callback(app, begun.cookie, begun.state)).headers.location).toBe(
      'http://localhost:5173/',
    );
    const replay = await callback(app, begun.cookie, begun.state);
    expect(String(replay.headers.location)).toContain('error=google');
    expect(replay.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    expect(calls.exchange).toBe(1);
    await app.close();
  });

  it('a failed token exchange lands on the generic error without a session', async () => {
    const failing: GoogleOAuthClient = {
      async exchangeCode() {
        throw new GoogleTokenError();
      },
      async verifyIdToken() {
        throw new Error('not reached');
      },
    };
    const app = await buildApp({ googleOAuth: { config: CONFIG, client: failing } });
    const begun = await start(app);
    const done = await callback(app, begun.cookie, begun.state);
    expect(done.headers.location).toBe('http://localhost:5173/login?error=google');
    expect(done.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    await app.close();
  });

  it('N-3: the per-IP budget is charged by /start only, never by cookieless callbacks', async () => {
    const { app } = await appFor(ada);
    for (let i = 0; i < AUTH_LIMITS.googlePerIp.limit * 2; i++) {
      const res = await callback(app, null, 'forged-state');
      expect(String(res.headers.location)).toContain('error=google');
    }
    for (let i = 0; i < AUTH_LIMITS.googlePerIp.limit; i++) {
      expect(
        new URL(
          String((await app.inject({ method: 'GET', url: '/auth/google/start' })).headers.location),
        ).origin,
      ).toBe('https://accounts.google.com');
    }
    const limited = await app.inject({ method: 'GET', url: '/auth/google/start?next=%2Fx' });
    expect(limited.headers.location).toBe('http://localhost:5173/login?error=google&next=%2Fx');
    expect(limited.cookies.some((c) => c.name.endsWith('meetops_oauth') && c.value)).toBe(false);
    await app.close();
  });
});

describe('N-3: Google rate limit without a client IP', () => {
  it('refuses instead of sharing one "unknown" bucket', async () => {
    const consumed: string[] = [];
    const auth = new AuthService({
      rateLimiter: {
        async consume(key: string) {
          consumed.push(key);
          return { allowed: true, retryAfterMs: 0 };
        },
      },
    } as unknown as AuthServiceDeps);
    await expect(auth.enforceGoogleRateLimit(null)).rejects.toBeInstanceOf(
      RateLimiterUnavailableError,
    );
    expect(consumed).toEqual([]);
    await auth.enforceGoogleRateLimit('203.0.113.9');
    expect(consumed).toEqual(['google:ip:203.0.113.9']);
  });
});

describe('N-1: email verification signs out the other sessions', () => {
  it('keeps only the verifying session of the same account', async () => {
    const app = await buildApp();
    const squatter = new Client(app);
    await squatter.post('/auth/signup', {
      name: 'M',
      email: 'vic@example.com',
      password: PASSWORD,
    });
    expect(
      (await squatter.post('/auth/login', { email: 'vic@example.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    const owner = new Client(app);
    expect(
      (await owner.post('/auth/login', { email: 'vic@example.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    const v = await owner.post('/auth/verify-email', {
      token: app.token('vic@example.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    expect(await sessionOk(owner)).toBe(200);
    expect(await sessionOk(squatter)).toBe(401);
    await app.close();
  });
});

/* Round 2 (Tester review of #459): N-1 residual, N-7, X1. */
describe('round 2: the mailbox owner wins over whoever registered the address', () => {
  const victim = (n: string, email: string): GoogleIdentity => ({
    sub: `55500000000${n}`,
    email,
    emailVerified: true,
    name: 'Victim',
    hd: null,
  });
  const passwordLogin = async (app: App, email: string) =>
    (await new Client(app).post('/auth/login', { email, password: PASSWORD })).statusCode;
  async function squat(app: App, email: string) {
    const attacker = new Client(app);
    expect(
      (await attacker.post('/auth/signup', { name: 'Mallory', email, password: PASSWORD }))
        .statusCode,
    ).toBe(202);
    expect((await attacker.post('/auth/login', { email, password: PASSWORD })).statusCode).toBe(
      200,
    );
    return attacker;
  }

  it('R1c (gmail): the victim verifies in another browser, THEN signs in with Google: password 401 throughout', async () => {
    const id = victim('1', 'vic1@gmail.com');
    const { app, users, audit } = await appFor(id);
    const attacker = await squat(app, 'vic1@gmail.com');
    const v = await new Client(app).post('/auth/verify-email', {
      token: app.token('vic1@gmail.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    // UX-1: only the token holder learns that the takeover ran.
    expect(v.headers['x-meetops-verify-outcome']).toBe('password_reset');
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'vic1@gmail.com')).toBe(401);
    const u = await users.findByEmail('vic1@gmail.com');
    expect(u?.passwordHash).toBe('');
    expect(u?.emailVerifiedAt).toBeTruthy();
    expect(audit.events.find((e) => e.action === 'auth.email.verify')?.metadata).toMatchObject({
      proof: 'mailbox',
      passwordRemoved: true,
    });
    // The mailbox owner gets a set-password link through the regular reset flow.
    expect(app.token('vic1@gmail.com', 'password_reset')).toBeTruthy();

    const { browser } = await googleSignIn(app);
    expect(await sessionOk(browser)).toBe(200);
    expect((await users.findByEmail('vic1@gmail.com'))?.googleSub).toBe(id.sub);
    expect(await passwordLogin(app, 'vic1@gmail.com')).toBe(401);
    await app.close();
  });

  it('R1b (gmail): Google directly, then verify: password 401 in this order too', async () => {
    const { app } = await appFor(victim('2', 'vic2@gmail.com'));
    const attacker = await squat(app, 'vic2@gmail.com');
    await googleSignIn(app);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'vic2@gmail.com')).toBe(401);
    await app.close();
  });

  it('R1a / B-1 (domain Google does not host): resend + verify elsewhere removes the squatter password', async () => {
    const { app, users } = await appFor(victim('3', 'vic3@corp.example'));
    const attacker = await squat(app, 'vic3@corp.example');
    // The victim's Google attempt is refused and pointed at a password reset (see apps/web google.tsx).
    const { done } = await googleSignIn(app);
    expect(String(done.headers.location)).toContain('error=google_unverified');
    expect(
      (await new Client(app).post('/auth/resend-verification', { email: 'vic3@corp.example' }))
        .statusCode,
    ).toBe(202);
    const v = await new Client(app).post('/auth/verify-email', {
      token: app.token('vic3@corp.example', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'vic3@corp.example')).toBe(401);
    // The owner sets their own password from the emailed link and can then sign in.
    const reset = await new Client(app).post('/auth/reset-password', {
      token: app.token('vic3@corp.example', 'password_reset')!,
      password: OWNER_PASSWORD,
    });
    expect(reset.statusCode).toBe(204);
    expect(
      (
        await new Client(app).post('/auth/login', {
          email: 'vic3@corp.example',
          password: OWNER_PASSWORD,
        })
      ).statusCode,
    ).toBe(200);
    expect((await users.findByEmail('vic3@corp.example'))?.emailVerifiedAt).toBeTruthy();
    await app.close();
  });

  it('B-1: a password reset by the mailbox owner also verifies the address and locks the squatter out', async () => {
    const { app, users } = await appFor(victim('4', 'vic4@corp.example'));
    const attacker = await squat(app, 'vic4@corp.example');
    await new Client(app).post('/auth/forgot-password', { email: 'vic4@corp.example' });
    const reset = await new Client(app).post('/auth/reset-password', {
      token: app.token('vic4@corp.example', 'password_reset')!,
      password: OWNER_PASSWORD,
    });
    expect(reset.statusCode).toBe(204);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'vic4@corp.example')).toBe(401);
    expect((await users.findByEmail('vic4@corp.example'))?.emailVerifiedAt).toBeTruthy();
    await app.close();
  });

  it('the registering browser (signup cookie) or a live session of the account keeps the password', async () => {
    const app = await buildApp();
    const same = new Client(app);
    const signup = await same.post('/auth/signup', {
      name: 'Ana',
      email: 'ana@example.com',
      password: PASSWORD,
    });
    const bind = signup.cookies.find((c) => c.name === SIGNUP_COOKIE);
    expect(bind?.httpOnly).toBe(true);
    expect(bind?.sameSite).toBe('Strict');
    const v = await same.post('/auth/verify-email', {
      token: app.token('ana@example.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    expect(v.cookies.find((c) => c.name === SIGNUP_COOKIE)?.value).toBe('');
    expect(await passwordLogin(app, 'ana@example.com')).toBe(200);

    // Logged in (unverified), verifying inside that session also keeps it.
    const other = new Client(app);
    await other.post('/auth/signup', { name: 'Bo', email: 'bo@example.com', password: PASSWORD });
    const phone = new Client(app);
    expect(
      (await phone.post('/auth/login', { email: 'bo@example.com', password: PASSWORD })).statusCode,
    ).toBe(200);
    expect(
      (
        await phone.post('/auth/verify-email', {
          token: app.token('bo@example.com', 'email_verification')!,
        })
      ).statusCode,
    ).toBe(204);
    expect(await passwordLogin(app, 'bo@example.com')).toBe(200);
    expect(await sessionOk(phone)).toBe(200);
    await app.close();
  });

  it('signup sets the same-shaped binding cookie for a taken email (enumeration-safe)', async () => {
    const app = await buildApp();
    await signupAndLogin(app, 'taken@example.com');
    const res = await new Client(app).post('/auth/signup', {
      name: 'X',
      email: 'taken@example.com',
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(202);
    const bind = res.cookies.find((c) => c.name === SIGNUP_COOKIE);
    expect(bind?.value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    await app.close();
  });

  it('a forged signup-binding cookie does not count as the registering browser', async () => {
    const app = await buildApp();
    const attacker = new Client(app);
    await attacker.post('/auth/signup', {
      name: 'M',
      email: 'forge@example.com',
      password: PASSWORD,
    });
    const victimBrowser = new Client(app);
    victimBrowser.jar.set(SIGNUP_COOKIE, `${attacker.jar.get(SIGNUP_COOKIE)}x`);
    await victimBrowser.post('/auth/verify-email', {
      token: app.token('forge@example.com', 'email_verification')!,
    });
    expect(await passwordLogin(app, 'forge@example.com')).toBe(401);
    await app.close();
  });

  it('X3 / N-7: an unproven Google identity never survives the real mailbox owner', async () => {
    const stale: GoogleIdentity = {
      sub: '9999',
      email: 'bob@corp.com',
      emailVerified: true,
      name: 'ExBob',
      hd: null,
    };
    const { app, users } = await appFor(stale);
    const { browser: staleBrowser, done } = await googleSignIn(app);
    expect(done.headers.location).toBe('http://localhost:5173/');
    expect((await users.findByEmail('bob@corp.com'))?.googleSub ?? null).toBeNull();

    // The real mailbox owner opens the verification mail in their own browser.
    const v = await new Client(app).post('/auth/verify-email', {
      token: app.token('bob@corp.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    const afterVerify = await users.findByEmail('bob@corp.com');
    expect(afterVerify?.googleSub ?? null).toBeNull();
    expect(afterVerify?.emailVerifiedAt).toBeTruthy();
    expect(await sessionOk(staleBrowser)).toBe(401);

    // The owner sets a password; the subject is still not linked.
    const r = await new Client(app).post('/auth/reset-password', {
      token: app.token('bob@corp.com', 'password_reset')!,
      password: OWNER_PASSWORD,
    });
    expect(r.statusCode).toBe(204);
    expect((await users.findByEmail('bob@corp.com'))?.googleSub ?? null).toBeNull();

    // The stale holder's Google sign-in gets no session (it would need the owner's password).
    const { done: again } = await googleSignIn(app);
    expect(String(again.headers.location)).toContain('error=google_link_password');
    expect(again.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    await app.close();
  });

  it('N-7 defence in depth: verify and reset drop a Google subject linked before the address was proven', async () => {
    const users = new InMemoryUserRepository();
    const now = new Date();
    for (const [id, email] of [
      ['00000000-0000-4000-8000-0000000000a1', 'legacy1@corp.com'],
      ['00000000-0000-4000-8000-0000000000a2', 'legacy2@corp.com'],
    ] as const) {
      await users.create({
        id,
        email,
        name: 'L',
        passwordHash: '',
        emailVerifiedAt: null,
        googleSub: `legacy-${id.slice(-2)}`,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
    const { app } = await appFor(victim('5', 'x@gmail.com'), { users });
    await new Client(app).post('/auth/resend-verification', { email: 'legacy1@corp.com' });
    await new Client(app).post('/auth/verify-email', {
      token: app.token('legacy1@corp.com', 'email_verification')!,
    });
    expect((await users.findByEmail('legacy1@corp.com'))?.googleSub ?? null).toBeNull();
    await new Client(app).post('/auth/forgot-password', { email: 'legacy2@corp.com' });
    await new Client(app).post('/auth/reset-password', {
      token: app.token('legacy2@corp.com', 'password_reset')!,
      password: OWNER_PASSWORD,
    });
    const l2 = await users.findByEmail('legacy2@corp.com');
    expect(l2?.googleSub ?? null).toBeNull();
    expect(l2?.emailVerifiedAt).toBeTruthy();
    await app.close();
  });

  it('X1: a failing revocation leaves the account untouched, and the retry still locks the squatter out', async () => {
    class Flaky extends InMemorySessionRepository {
      failures = 0;
      override async revokeAllForUser(userId: string, at: Date) {
        if (this.failures > 0) {
          this.failures--;
          throw new Error('db down');
        }
        return super.revokeAllForUser(userId, at);
      }
    }
    const sessions = new Flaky();
    const { app, users } = await appFor(victim('6', 'half@gmail.com'), { sessions });
    const attacker = await squat(app, 'half@gmail.com');

    sessions.failures = 1;
    const { done } = await googleSignIn(app);
    expect(String(done.headers.location)).toContain('error=google');
    const u = await users.findByEmail('half@gmail.com');
    // Nothing committed: still unverified, unlinked, and the password is untouched (no half-state).
    expect(u?.googleSub ?? null).toBeNull();
    expect(u?.emailVerifiedAt).toBeNull();
    expect(u?.passwordHash).not.toBe('');

    const { browser } = await googleSignIn(app);
    expect(await sessionOk(browser)).toBe(200);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'half@gmail.com')).toBe(401);
    await app.close();
  });

  it('X1: the same holds for the mailbox-owner verify', async () => {
    class Flaky extends InMemorySessionRepository {
      failures = 0;
      override async revokeAllForUser(userId: string, at: Date) {
        if (this.failures > 0) {
          this.failures--;
          throw new Error('db down');
        }
        return super.revokeAllForUser(userId, at);
      }
    }
    const sessions = new Flaky();
    const { app, users } = await appFor(victim('7', 'half2@gmail.com'), { sessions });
    const attacker = await squat(app, 'half2@gmail.com');
    await new Client(app).post('/auth/resend-verification', { email: 'half2@gmail.com' });
    sessions.failures = 1;
    const failed = await new Client(app).post('/auth/verify-email', {
      token: app.token('half2@gmail.com', 'email_verification')!,
    });
    // Round 3: a failed takeover transaction is a 503 (retryable), not a generic 500.
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['retry-after']).toBeDefined();
    expect((await users.findByEmail('half2@gmail.com'))?.emailVerifiedAt).toBeNull();
    expect(await sessionOk(attacker)).toBe(200);
    // Google proving the address later still performs the full takeover.
    await googleSignIn(app);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'half2@gmail.com')).toBe(401);
    await app.close();
  });

  it('concurrent proven callbacks send one account-linked notice, which says the password was removed', async () => {
    const { app } = await appFor(victim('8', 'race@gmail.com'));
    const attacker = await squat(app, 'race@gmail.com');
    await Promise.all([googleSignIn(app), googleSignIn(app)]);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await passwordLogin(app, 'race@gmail.com')).toBe(401);
    const notices = app.mail.sent.filter((m) => m.template === 'account_linked');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.data).toMatchObject({ passwordRemoved: 'true' });
    await app.close();
  });
});

/* Round 3 (Tester re-review of #459): X4, a sign-in already in flight when the takeover commits. */
describe('round 3: a sign-in in flight during a takeover never keeps a session', () => {
  /** Holds the next session insert (the point between the credential check and the session) until released. */
  class GatedSessions extends InMemorySessionRepository {
    private pending: { entered: () => void; gate: Promise<void> } | null = null;
    holdNext() {
      let entered!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      const gate = new Promise<void>((r) => (release = r));
      this.pending = { entered, gate };
      return { reached, release };
    }
    override async create(s: Parameters<InMemorySessionRepository['create']>[0]) {
      const p = this.pending;
      this.pending = null;
      if (p) {
        p.entered();
        await p.gate;
      }
      return super.create(s);
    }
  }
  const gmail = (n: string, email: string): GoogleIdentity => ({
    sub: `66600000000${n}`,
    email,
    emailVerified: true,
    name: 'Owner',
    hd: null,
  });
  async function squatter(app: App, email: string) {
    const c = new Client(app);
    expect(
      (await c.post('/auth/signup', { name: 'Mallory', email, password: PASSWORD })).statusCode,
    ).toBe(202);
    return c;
  }
  const live = async (
    sessions: InMemorySessionRepository,
    users: InMemoryUserRepository,
    e: string,
  ) => sessions.listActiveForUser((await users.findByEmail(e))!.id, new Date());

  it('X4: password login held past its check while the owner verifies elsewhere ends 401 with no session', async () => {
    const sessions = new GatedSessions();
    const { app, users, audit } = await appFor(gmail('1', 'inflight1@gmail.com'), { sessions });
    const attacker = await squatter(app, 'inflight1@gmail.com');
    const hold = sessions.holdNext();
    const login = attacker.post('/auth/login', {
      email: 'inflight1@gmail.com',
      password: PASSWORD,
    });
    await hold.reached; // the password was accepted; the session row is not written yet
    const v = await new Client(app).post('/auth/verify-email', {
      token: app.token('inflight1@gmail.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    expect(v.headers['x-meetops-verify-outcome']).toBe('password_reset');
    hold.release();
    const res = await login;
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'AUTH_FAILED' } });
    attacker.absorb(res);
    expect(await sessionOk(attacker)).toBe(401);
    expect(await live(sessions, users, 'inflight1@gmail.com')).toHaveLength(0);
    expect(audit.events.some((e) => e.metadata?.reason === 'credentials_changed')).toBe(true);
    await app.close();
  });

  it('X4: the same window during the Google takeover', async () => {
    const sessions = new GatedSessions();
    const { app, users } = await appFor(gmail('2', 'inflight2@gmail.com'), { sessions });
    const attacker = await squatter(app, 'inflight2@gmail.com');
    const hold = sessions.holdNext();
    const login = attacker.post('/auth/login', {
      email: 'inflight2@gmail.com',
      password: PASSWORD,
    });
    await hold.reached;
    const { browser } = await googleSignIn(app);
    expect(await sessionOk(browser)).toBe(200);
    hold.release();
    const res = await login;
    expect(res.statusCode).toBe(401);
    attacker.absorb(res);
    expect(await sessionOk(attacker)).toBe(401);
    // Only the owner's Google session is live.
    expect(await live(sessions, users, 'inflight2@gmail.com')).toHaveLength(1);
    await app.close();
  });

  it('X4: the other order (session written first, takeover after) is revoked by the takeover itself', async () => {
    const { app, users, sessions } = await appFor(gmail('3', 'inflight3@gmail.com'));
    const attacker = await squatter(app, 'inflight3@gmail.com');
    expect(
      (await attacker.post('/auth/login', { email: 'inflight3@gmail.com', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
    await new Client(app).post('/auth/verify-email', {
      token: app.token('inflight3@gmail.com', 'email_verification')!,
    });
    expect(await sessionOk(attacker)).toBe(401);
    expect(await live(sessions, users, 'inflight3@gmail.com')).toHaveLength(0);
    await app.close();
  });

  it('X4: an unproven Google sign-in held past its check loses to the mailbox owner verifying meanwhile', async () => {
    const sessions = new GatedSessions();
    const stale: GoogleIdentity = {
      sub: '666000000004',
      email: 'inflight4@corp.example',
      emailVerified: true,
      name: 'Stale',
      hd: null,
    };
    const { app, users } = await appFor(stale, { sessions });
    const hold = sessions.holdNext();
    const pending = googleSignIn(app);
    await hold.reached;
    const token = app.token('inflight4@corp.example', 'email_verification');
    expect(token).toBeTruthy();
    const v = await new Client(app).post('/auth/verify-email', { token: token! });
    expect(v.statusCode).toBe(204);
    hold.release();
    const { browser, done } = await pending;
    expect(String(done.headers.location)).toContain('error=google');
    expect(await sessionOk(browser)).toBe(401);
    expect(await live(sessions, users, 'inflight4@corp.example')).toHaveLength(0);
    await app.close();
  });

  it('post-commit revocations are retried; a step that keeps failing gives 503 and the set-password mail still goes out', async () => {
    // The push-device revoker lists the user's memberships; make that fail once (retried) or for good.
    class Flaky extends InMemoryMembershipRepository {
      failures = 0;
      calls = 0;
      override async listByUser(userId: string) {
        if (this.failures > 0) {
          this.calls++;
          this.failures--;
          throw new Error('store down');
        }
        return super.listByUser(userId);
      }
    }
    const memberships = new Flaky();
    const { app, users } = await appFor(gmail('6', 'follow6@gmail.com'), { memberships });
    const attacker = await squatter(app, 'follow6@gmail.com');
    memberships.failures = 1;
    const ok = await new Client(app).post('/auth/verify-email', {
      token: app.token('follow6@gmail.com', 'email_verification')!,
    });
    expect(ok.statusCode).toBe(204); // one blip, retried
    expect(memberships.calls).toBe(1);

    const other = await squatter(app, 'follow7@gmail.com');
    memberships.failures = 99;
    memberships.calls = 0;
    const v = await new Client(app).post('/auth/verify-email', {
      token: app.token('follow7@gmail.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(503);
    expect(memberships.calls).toBe(3);
    memberships.failures = 0;
    // The claim itself committed: verified, password gone, set-password link sent.
    const u = await users.findByEmail('follow7@gmail.com');
    expect(u?.emailVerifiedAt).toBeTruthy();
    expect(u?.passwordHash).toBe('');
    expect(app.token('follow7@gmail.com', 'password_reset')).toBeTruthy();
    expect(await sessionOk(attacker)).toBe(401);
    expect(await sessionOk(other)).toBe(401);
    await app.close();
  });

  it('verify in the registering browser reports the plain outcome', async () => {
    const { app } = await appFor(gmail('5', 'plain5@gmail.com'));
    const c = await squatter(app, 'plain5@gmail.com');
    const v = await c.post('/auth/verify-email', {
      token: app.token('plain5@gmail.com', 'email_verification')!,
    });
    expect(v.statusCode).toBe(204);
    expect(v.headers['x-meetops-verify-outcome']).toBe('verified');
    await app.close();
  });
});
