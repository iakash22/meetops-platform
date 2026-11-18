import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GoogleTokenError,
  OAUTH_STATE_TTL_MS,
  deriveOAuthStateKey,
  googleEmailProven,
  openPendingLink,
  sealPendingLink,
  openOAuthState,
  pkceChallenge,
  readGoogleOAuthConfig,
  safeNext,
  sealOAuthState,
  verifyGoogleIdToken,
  type OAuthStatePayload,
} from '../src/modules/auth/application/google-oidc.js';

const secret = Buffer.alloc(32, 7);

describe('safeNext', () => {
  it('keeps a same-origin path and rejects anything that could leave the app', () => {
    expect(safeNext('/meetings')).toBe('/meetings');
    expect(safeNext('/meetings?tab=1#x')).toBe('/meetings?tab=1#x');
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/\\evil',
      '/%2F%2Fevil.example',
      '',
      'meetings',
    ]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});

describe('oauth state cookie', () => {
  const payload: OAuthStatePayload = {
    state: 'state-value',
    nonce: 'nonce-value-0123456789abcdef0123456789',
    verifier: 'a'.repeat(43),
    next: '/meetings',
    exp: Date.now() + 60_000,
  };

  it('round-trips and rejects a tampered cookie, a wrong state, and an expired one', () => {
    const sealed = sealOAuthState(payload, secret);
    expect(openOAuthState(sealed, payload.state, secret, Date.now())?.next).toBe('/meetings');
    expect(openOAuthState(`${sealed}x`, payload.state, secret, Date.now())).toBeNull();
    expect(openOAuthState(sealed, 'other-state', secret, Date.now())).toBeNull();
    expect(openOAuthState(sealed, payload.state, secret, payload.exp + 1)).toBeNull();
    expect(OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('does not put the verifier in the comparison state', () => {
    const sealed = sealOAuthState(payload, secret);
    expect(sealed).not.toContain(payload.verifier);
  });
});

describe('readGoogleOAuthConfig', () => {
  const good = {
    GOOGLE_OAUTH_CLIENT_ID: '1234567890-abc.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'super-secret-value',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example/api/auth/google/callback',
  };

  it('is off when unset and refuses a partial or insecure redirect', () => {
    expect(readGoogleOAuthConfig({}, 'production')).toBeNull();
    expect(() =>
      readGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: good.GOOGLE_OAUTH_CLIENT_ID }, 'production'),
    ).toThrow(/together/);
    expect(() =>
      readGoogleOAuthConfig(
        { ...good, GOOGLE_OAUTH_REDIRECT_URI: 'http://app.example/api/auth/google/callback' },
        'production',
      ),
    ).toThrow(/https/);
    expect(() =>
      readGoogleOAuthConfig(
        { ...good, GOOGLE_OAUTH_REDIRECT_URI: 'https://app.example/auth/google/callback?x=1' },
        'production',
      ),
    ).toThrow(/query/);
    const dev = readGoogleOAuthConfig(
      { ...good, GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:5173/api/auth/google/callback' },
      'development',
    );
    expect(dev?.redirectUri).toContain('localhost:5173');
  });
});

describe('verifyGoogleIdToken', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as unknown as JsonWebKey & { kid: string };
  jwk.kid = 'test-key';
  const audience = '1234567890-abc.apps.googleusercontent.com';
  const nonce = 'nonce-value-0123456789abcdef';
  const now = new Date('2026-11-06T12:00:00.000Z');

  function token(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
    const h = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...header }),
    ).toString('base64url');
    const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const data = `${h}.${b}`;
    const sig = createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
    return `${data}.${sig}`;
  }

  const valid = () =>
    token({
      iss: 'https://accounts.google.com',
      aud: audience,
      sub: '109876543210',
      email: 'Ada@Example.com',
      email_verified: true,
      nonce,
      name: 'Ada',
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 300,
    });

  it('accepts a signed token and rejects nonce, audience, unverified email, alg and expiry', () => {
    expect(verifyGoogleIdToken(valid(), jwk, { audience, nonce, now })).toMatchObject({
      sub: '109876543210',
      email: 'Ada@Example.com',
      emailVerified: true,
      name: 'Ada',
    });
    expect(pkceChallenge('a'.repeat(43))).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(() =>
      verifyGoogleIdToken(valid(), jwk, { audience, nonce: 'other-nonce-0123456789', now }),
    ).toThrow(GoogleTokenError);
    expect(() =>
      verifyGoogleIdToken(valid(), jwk, { audience: 'other-client', nonce, now }),
    ).toThrow(GoogleTokenError);
    const unverified = token({
      iss: 'https://accounts.google.com',
      aud: audience,
      sub: '109876543210',
      email: 'ada@example.com',
      email_verified: false,
      nonce,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 300,
    });
    expect(() => verifyGoogleIdToken(unverified, jwk, { audience, nonce, now })).toThrow(
      GoogleTokenError,
    );
    const none = token(
      {
        iss: 'https://accounts.google.com',
        aud: audience,
        sub: '109876543210',
        email: 'ada@example.com',
        email_verified: true,
        nonce,
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(now.getTime() / 1000) + 300,
      },
      { alg: 'none' },
    );
    expect(() => verifyGoogleIdToken(none, jwk, { audience, nonce, now })).toThrow(
      GoogleTokenError,
    );
    const expired = token({
      iss: 'https://accounts.google.com',
      aud: audience,
      sub: '109876543210',
      email: 'ada@example.com',
      email_verified: true,
      nonce,
      iat: Math.floor(now.getTime() / 1000) - 900,
      exp: Math.floor(now.getTime() / 1000) - 600,
    });
    expect(() => verifyGoogleIdToken(expired, jwk, { audience, nonce, now })).toThrow(
      GoogleTokenError,
    );
  });
});

describe('verifyGoogleIdToken failure cases (OIDC review L-5)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as unknown as JsonWebKey & { kid: string };
  jwk.kid = 'test-key';
  const audience = '1234567890-abc.apps.googleusercontent.com';
  const nonce = 'nonce-value-0123456789abcdef';
  const now = new Date('2026-11-06T12:00:00.000Z');
  const t = Math.floor(now.getTime() / 1000);
  const base = {
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: '109876543210',
    email: 'ada@gmail.com',
    email_verified: true,
    nonce,
    iat: t,
    exp: t + 300,
  };
  function token(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
    key = privateKey,
  ) {
    const h = Buffer.from(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key', ...header }),
    ).toString('base64url');
    const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createSign('RSA-SHA256').update(`${h}.${b}`).sign(key).toString('base64url');
    return `${h}.${b}.${sig}`;
  }
  const verify = (tok: string, at = now) =>
    verifyGoogleIdToken(tok, jwk, { audience, nonce, now: at });
  const rejects = (tok: string, at = now) =>
    expect(() => verify(tok, at)).toThrow(GoogleTokenError);

  it('accepts the bare-host issuer and returns hd', () => {
    expect(verify(token({ ...base, iss: 'accounts.google.com', hd: 'example.com' })).hd).toBe(
      'example.com',
    );
    expect(verify(token(base)).hd).toBeNull();
  });
  it('rejects a wrong issuer', () => rejects(token({ ...base, iss: 'https://evil.example' })));
  it('rejects an azp that is not us', () => rejects(token({ ...base, azp: 'other-client' })));
  it('L-2: several audiences need azp === client id', () => {
    rejects(token({ ...base, aud: [audience, 'other-client'] }));
    rejects(token({ ...base, aud: [audience, 'other-client'], azp: 'other-client' }));
    expect(verify(token({ ...base, aud: [audience, 'other-client'], azp: audience })).sub).toBe(
      base.sub,
    );
    expect(verify(token({ ...base, aud: [audience] })).sub).toBe(base.sub);
  });
  it('rejects a token signed by another key', () => rejects(token(base, {}, other.privateKey)));
  it('rejects a kid that does not match the key', () => rejects(token(base, { kid: 'other' })));
  it('rejects an iat in the future beyond the skew, accepts one inside it', () => {
    rejects(token({ ...base, iat: t + 120 }));
    expect(verify(token({ ...base, iat: t + 30 })).sub).toBe(base.sub);
  });
  it('clock skew: a just-expired token passes within 60 s, not after', () => {
    const tok = token({ ...base, iat: t - 200, exp: t - 30 });
    expect(verify(tok).sub).toBe(base.sub);
    rejects(token({ ...base, iat: t - 400, exp: t - 90 }));
  });
  it('N-6: an ID token issued longer ago than the round trip is refused', () => {
    rejects(token({ ...base, iat: t - 12 * 60, exp: t + 3600 }));
    expect(verify(token({ ...base, iat: t - 8 * 60, exp: t + 3600 })).sub).toBe(base.sub);
  });
});

describe('googleEmailProven (M-2 / N-2)', () => {
  const id = (email: string, hd: string | null = null, emailVerified = true) => ({
    sub: 's',
    email,
    emailVerified,
    name: null,
    hd,
  });
  it('trusts only Google-hosted mailboxes', () => {
    expect(googleEmailProven(id('Ada@Gmail.com'))).toBe(true);
    expect(googleEmailProven(id('ada@googlemail.com'))).toBe(true);
    expect(googleEmailProven(id('ada@example.com', 'Example.com'))).toBe(true);
    expect(googleEmailProven(id('ada@example.com'))).toBe(false);
    expect(googleEmailProven(id('ada@example.com', 'other.com'))).toBe(false);
    expect(googleEmailProven(id('ada@sub.example.com', 'example.com'))).toBe(false);
    expect(googleEmailProven(id('ada@gmail.com', null, false))).toBe(false);
    expect(googleEmailProven(id('gmail.com'))).toBe(false);
  });
});

describe('cookie keys (L-4) and the pending link cookie', () => {
  it('derives distinct keys per purpose and never uses CSRF_SECRET itself', () => {
    const state = deriveOAuthStateKey(secret);
    const link = deriveOAuthStateKey(secret, 'oauth-link');
    expect(state.length).toBe(32);
    expect(state.equals(secret)).toBe(false);
    expect(state.equals(link)).toBe(false);
    const payload: OAuthStatePayload = {
      state: 'state-value',
      nonce: 'nonce-value-0123456789abcdef0123456789',
      verifier: 'a'.repeat(43),
      next: '/',
      exp: Date.now() + 60_000,
    };
    // A cookie MACed with the raw secret (the old scheme) no longer opens.
    expect(
      openOAuthState(sealOAuthState(payload, secret), payload.state, state, Date.now()),
    ).toBeNull();
    expect(
      openOAuthState(sealOAuthState(payload, state), payload.state, state, Date.now()),
    ).not.toBeNull();
  });
  it('round-trips a pending link and rejects tampering, the wrong key and expiry', () => {
    const key = deriveOAuthStateKey(secret, 'oauth-link');
    const now = Date.now();
    const sealed = sealPendingLink({ uid: 'u1', sub: 's1', exp: now + 60_000 }, key);
    expect(openPendingLink(sealed, key, now)).toEqual({ userId: 'u1', sub: 's1' });
    expect(openPendingLink(`${sealed}x`, key, now)).toBeNull();
    expect(openPendingLink(sealed, deriveOAuthStateKey(secret), now)).toBeNull();
    expect(openPendingLink(sealed, key, now + 61_000)).toBeNull();
    expect(openPendingLink(undefined, key, now)).toBeNull();
  });
});
