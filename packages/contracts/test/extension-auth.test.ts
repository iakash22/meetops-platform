import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  EXTENSION_AUTH_PATHS, EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS, EXTENSION_TOKEN_TTL_SECONDS, ExtensionPairRequest,
  ExtensionPairResponse, ExtensionRefreshRequest, ExtensionRefreshResponse, ExtensionRevokeRequest, ExtensionRevokeResponse,
  ExtensionTokenRequest, ExtensionTokenResponse, REDACT_KEYS,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-21T17:00:00.000Z';
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const nonce = 'aZ09_-'.repeat(7); // 42 base64url chars
const pair = { extensionId, deviceId: id(1), nonce };
const tokens = {
  accessToken: 'a'.repeat(64), refreshToken: 'r'.repeat(64), tokenType: 'Bearer', audience: 'extension', expiresAt: at,
  expiresIn: 900, refreshExpiresAt: at, organizationId: id(2), scopes: ['meetings:resolve', 'recordings:write'],
};

describe('ADR-005 amendment: constants', () => {
  it('keeps access TTL at 15 min and caps the refresh family at 30 days', () => {
    expect(EXTENSION_TOKEN_TTL_SECONDS).toBe(900);
    expect(EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS).toBe(2_592_000);
  });
  it('has endpoint paths', () => {
    expect(EXTENSION_AUTH_PATHS).toEqual({
      pair: '/auth/extension/pair', token: '/auth/extension-token', refresh: '/auth/extension/refresh', revoke: '/auth/extension/revoke',
    });
  });
  it('REDACT_KEYS covers both tokens', () => {
    expect(REDACT_KEYS).toContain('accessToken');
    expect(REDACT_KEYS).toContain('refreshToken');
  });
});

describe('ExtensionPairRequest', () => {
  it('accepts a valid request, with and without deviceLabel', () => {
    expect(Value.Check(ExtensionPairRequest, pair)).toBe(true);
    expect(Value.Check(ExtensionPairRequest, { ...pair, deviceLabel: 'Chrome on Mac — work' })).toBe(true);
    expect(Value.Check(ExtensionPairRequest, { ...pair, deviceLabel: 'Chrome on MacBook' })).toBe(true);
    expect(Value.Check(ExtensionPairRequest, { ...pair, deviceLabel: 'Büro PC' })).toBe(true);
  });
  it('bounds the nonce to 32..128 base64url chars', () => {
    expect(Value.Check(ExtensionPairRequest, { ...pair, nonce: 'a'.repeat(32) })).toBe(true);
    expect(Value.Check(ExtensionPairRequest, { ...pair, nonce: 'a'.repeat(128) })).toBe(true);
    expect(Value.Check(ExtensionPairRequest, { ...pair, nonce: 'a'.repeat(31) })).toBe(false);
    expect(Value.Check(ExtensionPairRequest, { ...pair, nonce: 'a'.repeat(129) })).toBe(false);
    expect(Value.Check(ExtensionPairRequest, { ...pair, nonce: 'a'.repeat(40) + '+/=' })).toBe(false);
    const noNonce: Record<string, unknown> = { ...pair };
    delete noNonce.nonce;
    expect(Value.Check(ExtensionPairRequest, noNonce)).toBe(false);
  });
  it('requires a UUID deviceId', () => {
    expect(Value.Check(ExtensionPairRequest, { ...pair, deviceId: 'device-1' })).toBe(false);
    expect(Value.Check(ExtensionPairRequest, { ...pair, deviceId: id(1) + 'x'.repeat(64) })).toBe(false);
    expect(Value.Check(ExtensionPairRequest, { ...pair, deviceId: '' })).toBe(false);
  });
  it('rejects non-printable deviceLabel and overlong labels', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u0007b', 'a\u007Fb', 'a\u0085b', 'a\u2028b', '\t', '', 'x'.repeat(101)]) {
      expect(Value.Check(ExtensionPairRequest, { ...pair, deviceLabel: bad })).toBe(false);
    }
  });
  it('rejects HTML-significant and bidi/format characters in deviceLabel', () => {
    const bads = ['<img src=x onerror=alert(1)>', 'a<b', 'a>b', 'a"b', "a'b", 'a&b', "Akash's laptop",
      'a\u202Eb', 'a\u200Eb', 'a\u200Fb', 'a\u202Ab', 'a\u2066b', 'a\u2069b',
      'a\u200Bb', 'a\u200Cb', 'a\u200Db', 'a\u2060b', 'a\uFEFFb', '\uFEFF', 'a\u061Cb'];
    for (const bad of bads) {
      expect(Value.Check(ExtensionPairRequest, { ...pair, deviceLabel: bad })).toBe(false);
    }
  });
  it('is strict', () => {
    expect(Value.Check(ExtensionPairRequest, { ...pair, scopes: ['recordings:write'] })).toBe(false);
  });
  it('pair response carries no tokens and names the org', () => {
    const r = { pairingCode: 'p'.repeat(43), expiresAt: at, organizationId: id(2), organizationName: 'Acme' };
    expect(Value.Check(ExtensionPairResponse, r)).toBe(true);
    expect(Value.Check(ExtensionPairResponse, { ...r, accessToken: 'a'.repeat(64) })).toBe(false);
  });
});

describe('ExtensionTokenRequest / Response', () => {
  it('request carries the nonce', () => {
    const t = { extensionId, deviceId: id(1), pairingCode: 'p'.repeat(43), nonce };
    expect(Value.Check(ExtensionTokenRequest, t)).toBe(true);
    expect(Value.Check(ExtensionTokenRequest, { ...t, nonce: 'short' })).toBe(false);
  });
  const r = { ...tokens, nonce };
  it('accepts a full response with the echoed nonce', () => {
    expect(Value.Check(ExtensionTokenResponse, r)).toBe(true);
    const noNonce: Record<string, unknown> = { ...r };
    delete noNonce.nonce;
    expect(Value.Check(ExtensionTokenResponse, noNonce)).toBe(false);
  });
  it('is strict', () => {
    expect(Value.Check(ExtensionTokenResponse, { ...r, idToken: 'x' })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, orgId: id(2) })).toBe(false);
  });
  it('pins tokenType, audience and expiresIn', () => {
    expect(Value.Check(ExtensionTokenResponse, { ...r, tokenType: 'bearer' })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, audience: 'web' })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, expiresIn: 901 })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, expiresIn: 0 })).toBe(false);
  });
  it('scopes: maxItems 2, unique, known only', () => {
    expect(Value.Check(ExtensionTokenResponse, { ...r, scopes: ['meetings:resolve', 'recordings:write', 'meetings:resolve'] })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, scopes: ['recordings:write', 'recordings:write'] })).toBe(false);
    expect(Value.Check(ExtensionTokenResponse, { ...r, scopes: ['admin'] })).toBe(false);
  });
});

describe('refresh and revoke', () => {
  it('refresh request/response shapes', () => {
    const q = { extensionId, deviceId: id(1), refreshToken: 'r'.repeat(64) };
    expect(Value.Check(ExtensionRefreshRequest, q)).toBe(true);
    expect(Value.Check(ExtensionRefreshRequest, { ...q, refreshToken: 'short' })).toBe(false);
    expect(Value.Check(ExtensionRefreshRequest, { ...q, accessToken: 'a'.repeat(64) })).toBe(false);
    expect(Value.Check(ExtensionRefreshResponse, tokens)).toBe(true);
    expect(Value.Check(ExtensionRefreshResponse, { ...tokens, extra: 1 })).toBe(false);
    expect(Value.Check(ExtensionRefreshResponse, { ...tokens, scopes: ['a', 'b', 'c'] })).toBe(false);
  });
  it('revoke request/response shapes', () => {
    expect(Value.Check(ExtensionRevokeRequest, { extensionId, deviceId: id(1) })).toBe(false);
    expect(Value.Check(ExtensionRevokeRequest, { extensionId, deviceId: id(1), refreshToken: 'r'.repeat(64) })).toBe(true);
    expect(Value.Check(ExtensionRevokeRequest, { extensionId })).toBe(false);
    expect(Value.Check(ExtensionRevokeRequest, { extensionId, deviceId: id(1), all: true })).toBe(false);
    expect(Value.Check(ExtensionRevokeResponse, { revoked: true })).toBe(true);
    expect(Value.Check(ExtensionRevokeResponse, { revoked: false })).toBe(false);
  });
});
