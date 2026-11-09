import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GoogleTokenError,
  OAUTH_STATE_TTL_MS,
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
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey & { kid: string };
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
