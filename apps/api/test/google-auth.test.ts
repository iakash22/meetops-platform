import { describe, expect, it } from 'vitest';
import { GoogleTokenError } from '../src/modules/auth/application/google-oidc.js';
import type { GoogleOAuthClient } from '../src/modules/auth/application/google-oauth.js';
import type { GoogleIdentity } from '../src/modules/auth/application/google-oidc.js';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository.js';
import { buildApp, Client, PASSWORD, SID, signupAndLogin, type App } from './helpers.js';

const CONFIG = {
  clientId: '1234567890-abc.apps.googleusercontent.com',
  clientSecret: 'test-secret-value',
  redirectUri: 'http://localhost:5173/api/auth/google/callback',
};

function fakeClient(identity: GoogleIdentity): GoogleOAuthClient {
  return {
    async exchangeCode({ code, codeVerifier, config }) {
      if (code !== 'good-code' || codeVerifier.length < 43) throw new GoogleTokenError();
      if (config.clientSecret !== CONFIG.clientSecret) throw new GoogleTokenError();
      return 'fake-id-token';
    },
    async verifyIdToken(_idToken, expected) {
      if (expected.audience !== CONFIG.clientId || expected.nonce.length < 32) {
        throw new GoogleTokenError();
      }
      return identity;
    },
  };
}

async function appFor(identity: GoogleIdentity, users = new InMemoryUserRepository()) {
  const app = await buildApp({
    users,
    googleOAuth: { config: CONFIG, client: fakeClient(identity) },
  });
  return { app, users };
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
  cookie: { name: string; value: string },
  state: string | null,
  code = 'good-code',
) {
  const q = new URLSearchParams();
  if (code) q.set('code', code);
  if (state) q.set('state', state);
  q.set('scope', 'openid email profile');
  return app.inject({
    method: 'GET',
    url: `/auth/google/callback?${q.toString()}`,
    headers: { cookie: `${cookie.name}=${cookie.value}` },
  });
}

describe('google sign-in', () => {
  const ada: GoogleIdentity = {
    sub: '109876543210',
    email: 'Ada@Example.com',
    emailVerified: true,
    name: 'Ada Lovelace',
  };

  it('hides the provider when it is not configured', async () => {
    const app = await buildApp();
    const providers = await app.inject({ method: 'GET', url: '/auth/providers' });
    expect(providers.json()).toEqual({ google: false });
    expect((await app.inject({ method: 'GET', url: '/auth/google/start' })).statusCode).toBe(404);
    await app.close();
  });

  it('creates a verified account on first use and signs in on the second', async () => {
    const { app, users } = await appFor(ada);
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

    const user = await users.findByEmail('ada@example.com');
    expect(user?.googleSub).toBe(ada.sub);
    expect(user?.emailVerifiedAt).toBeTruthy();
    expect(user?.passwordHash).toBe('');
    expect(user?.name).toBe('Ada Lovelace');

    const session = await new Client(app).get('/auth/session');
    // The client above has no cookie. Use the callback cookies.
    const authed = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: {
        cookie: done.cookies
          .filter((c) => c.value)
          .map((c) => `${c.name}=${c.value}`)
          .join('; '),
      },
    });
    expect(session.statusCode).toBe(401);
    expect(authed.statusCode).toBe(200);
    expect(authed.json().user.email).toBe('ada@example.com');

    const again = await start(app);
    const second = await callback(app, again.cookie, again.state);
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe('http://localhost:5173/');
    expect(await users.findByGoogleSub(ada.sub)).toMatchObject({ id: user?.id });
    await app.close();
  });

  it('does not link a Google identity onto an unverified password account', async () => {
    const users = new InMemoryUserRepository();
    const { app } = await appFor(ada, users);
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
    expect((await users.findByEmail('ada@example.com'))?.googleSub ?? null).toBeNull();
    await app.close();
  });

  it('links Google onto a verified password account and ignores an open redirect', async () => {
    const users = new InMemoryUserRepository();
    const app = await buildApp({
      users,
      googleOAuth: { config: CONFIG, client: fakeClient(ada) },
    });
    await signupAndLogin(app, 'ada@example.com');
    const begun = await start(app, 'https://evil.example/phish');
    const done = await callback(app, begun.cookie, begun.state);
    expect(done.headers.location).toBe('http://localhost:5173/');
    expect(String(done.headers.location)).not.toContain('evil.example');
    expect((await users.findByEmail('ada@example.com'))?.googleSub).toBe(ada.sub);
    await app.close();
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const { app } = await appFor(ada);
    const begun = await start(app);
    const done = await callback(app, begun.cookie, 'not-the-state');
    expect(String(done.headers.location)).toContain('error=google');
    expect(String(done.headers.location)).not.toContain('google_unverified');
    expect(done.cookies.some((c) => c.name === SID && c.value)).toBe(false);
    await app.close();
  });
});
