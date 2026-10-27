import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  AUTH_REVOCATION_REASONS,
  DESKTOP_AUTH_PATHS,
  DESKTOP_SCOPES,
  DESKTOP_TOKEN_TTL_SECONDS,
  DesktopAuthorizeRequest,
  DesktopAuthorizeResponse,
  DesktopRedirectUri,
  DesktopRefreshRequest,
  DesktopRevokeResponse,
  DesktopSwitchOrgRequest,
  DesktopTokenRequest,
  DesktopTokenResponse,
  PkceCodeVerifier,
  REDACT_KEYS,
} from '../src/index.js';
import * as light from '../src/types.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const at = '2026-10-27T10:00:00.000Z';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const redirectUri = 'http://127.0.0.1:53682/callback';
const code = 'c'.repeat(43);

describe('v0.9.0 package and constants', () => {
  it('is 0.9.0 or later', () => expect(pkg.version).toMatch(/^0\.(9|\d{2,})\.\d+$/));
  it('pins the ADR-012 token model', () => {
    expect(DESKTOP_TOKEN_TTL_SECONDS).toBe(900);
    expect(DESKTOP_SCOPES).toEqual([
      'meetings:read',
      'meetings:resolve',
      'tasks:read',
      'recordings:write',
    ]);
    expect(DESKTOP_AUTH_PATHS).toEqual({
      authorize: '/auth/desktop/authorize',
      token: '/auth/desktop/token',
      refresh: '/auth/desktop/refresh',
      revoke: '/auth/desktop/revoke',
      switchOrg: '/auth/desktop/switch-org',
    });
    expect(light.DESKTOP_AUTH_PATHS).toBe(DESKTOP_AUTH_PATHS);
  });
  it('grants no write or admin scope on tasks', () => {
    expect(DESKTOP_SCOPES.some((s) => s.startsWith('tasks:') && s !== 'tasks:read')).toBe(false);
  });
  it('adds desktop_revoked and redacts the PKCE secrets but not error codes', () => {
    expect(AUTH_REVOCATION_REASONS).toContain('desktop_revoked');
    for (const k of ['authorizationCode', 'codeVerifier', 'code_verifier'])
      expect(REDACT_KEYS).toContain(k);
    expect(REDACT_KEYS as readonly string[]).not.toContain('code');
  });
});

describe('DesktopRedirectUri', () => {
  it('accepts only http://127.0.0.1:<port>/callback', () => {
    for (const ok of [
      redirectUri,
      'http://127.0.0.1:1024/callback',
      'http://127.0.0.1:65535/callback',
    ])
      expect(Value.Check(DesktopRedirectUri, ok), ok).toBe(true);
    for (const bad of [
      'https://127.0.0.1:53682/callback',
      'http://localhost:53682/callback',
      'http://0.0.0.0:53682/callback',
      'http://[::1]:53682/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:80/callback',
      'http://127.0.0.1:65536/callback',
      'http://127.0.0.1:53682/callback?x=1',
      'http://127.0.0.1:53682/callback#f',
      'http://u@127.0.0.1:53682/callback',
      'http://127.0.0.1:53682/other',
      'http://127.0.0.1:53682/callback/',
    ])
      expect(Value.Check(DesktopRedirectUri, bad), bad).toBe(false);
  });
});

describe('authorize and token', () => {
  const authorize = {
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    redirectUri,
    deviceId: id(1),
  };
  it('authorize requires S256 and is strict', () => {
    expect(Value.Check(DesktopAuthorizeRequest, authorize)).toBe(true);
    expect(
      Value.Check(DesktopAuthorizeRequest, { ...authorize, deviceLabel: 'MacBook — work' }),
    ).toBe(true);
    expect(
      Value.Check(DesktopAuthorizeRequest, { ...authorize, codeChallengeMethod: 'plain' }),
    ).toBe(false);
    expect(Value.Check(DesktopAuthorizeRequest, { ...authorize, codeChallenge: 'short' })).toBe(
      false,
    );
    expect(Value.Check(DesktopAuthorizeRequest, { ...authorize, state: 'x'.repeat(43) })).toBe(
      false,
    );
    expect(Value.Check(DesktopAuthorizeRequest, { ...authorize, deviceLabel: '<script>' })).toBe(
      false,
    );
  });
  it('authorize response carries no tokens', () => {
    const r = {
      authorizationCode: code,
      expiresAt: at,
      organizationId: id(2),
      organizationName: 'Acme',
    };
    expect(Value.Check(DesktopAuthorizeResponse, r)).toBe(true);
    expect(Value.Check(DesktopAuthorizeResponse, { ...r, accessToken: 'a'.repeat(64) })).toBe(
      false,
    );
  });
  it('token request bounds the verifier (RFC 7636)', () => {
    const t = { authorizationCode: code, codeVerifier: verifier, redirectUri, deviceId: id(1) };
    expect(Value.Check(DesktopTokenRequest, t)).toBe(true);
    expect(Value.Check(PkceCodeVerifier, 'a'.repeat(42))).toBe(false);
    expect(Value.Check(PkceCodeVerifier, 'a'.repeat(129))).toBe(false);
    expect(Value.Check(PkceCodeVerifier, 'a'.repeat(42) + '~')).toBe(true);
    expect(Value.Check(DesktopTokenRequest, { ...t, code })).toBe(false);
  });
  const tokens = {
    accessToken: 'a'.repeat(64),
    refreshToken: 'r'.repeat(64),
    tokenType: 'Bearer',
    audience: 'desktop',
    expiresAt: at,
    expiresIn: 900,
    refreshExpiresAt: at,
    organizationId: id(2),
    scopes: [...DESKTOP_SCOPES],
  };
  it('token response pins audience, ttl and known scopes', () => {
    expect(Value.Check(DesktopTokenResponse, tokens)).toBe(true);
    expect(Value.Check(DesktopTokenResponse, { ...tokens, audience: 'extension' })).toBe(false);
    expect(Value.Check(DesktopTokenResponse, { ...tokens, expiresIn: 901 })).toBe(false);
    expect(Value.Check(DesktopTokenResponse, { ...tokens, scopes: ['tasks:write'] })).toBe(false);
    expect(Value.Check(DesktopTokenResponse, { ...tokens, scopes: [] })).toBe(false);
    expect(Value.Check(DesktopTokenResponse, { ...tokens, nonce: 'n'.repeat(43) })).toBe(false);
  });
});

describe('refresh, revoke, switch-org', () => {
  it('are bound to deviceId and strict', () => {
    const r = { deviceId: id(1), refreshToken: 'r'.repeat(64) };
    expect(Value.Check(DesktopRefreshRequest, r)).toBe(true);
    expect(Value.Check(DesktopRefreshRequest, { refreshToken: r.refreshToken })).toBe(false);
    expect(Value.Check(DesktopSwitchOrgRequest, { ...r, organizationId: id(3) })).toBe(true);
    expect(Value.Check(DesktopSwitchOrgRequest, r)).toBe(false);
    expect(Value.Check(DesktopRevokeResponse, { revoked: true })).toBe(true);
  });
});
