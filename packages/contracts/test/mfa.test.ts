import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as Light from '../src/types.js';
import {
  API_ERROR_CODES,
  ApiErrorCode,
  AuthSession,
  GetAuthSessionResponse,
  LoginResponse,
  MFA_CHALLENGE_PURPOSE,
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_PATHS,
  MfaChallengeRequest,
  MfaChallengeResponse,
  MfaCodeRequest,
  MfaLoginChallenge,
  MfaElevationResponse,
  MfaRecoveryCodesResponse,
  MfaStatusResponse,
  MfaTotpConfirmRequest,
  MfaTotpEnrollResponse,
  REDACT_KEYS,
  SESSION_AUTH_LEVELS,
} from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const at = '2026-11-11T10:00:00.000Z';
const csrf = 'c'.repeat(32);

describe('ADR-021 MFA contracts', () => {
  it('adds the three MFA error codes to both the schema and API_ERROR_CODES', () => {
    for (const c of ['MFA_REQUIRED', 'STEP_UP_REQUIRED', 'INVALID_MFA_CODE'] as const) {
      expect(API_ERROR_CODES).toContain(c);
      expect(Light.API_ERROR_CODES).toContain(c);
    }
    expect(ApiErrorCode.anyOf.map((s) => s.const)).toEqual([...API_ERROR_CODES]);
  });

  it('pins the MFA paths (the #456 suite and the API use these)', () => {
    expect(MFA_PATHS).toEqual({
      status: '/auth/mfa',
      enroll: '/auth/mfa/totp/enroll',
      confirm: '/auth/mfa/totp/confirm',
      challenge: '/auth/mfa/challenge',
      stepUp: '/auth/mfa/step-up',
      recoveryCodes: '/auth/mfa/recovery-codes',
      factor: '/auth/mfa/factors/:factorId',
    });
    expect(Light.MFA_PATHS).toBe(MFA_PATHS);
    expect(SESSION_AUTH_LEVELS).toEqual(['password', 'google', 'mfa']);
  });

  it('MfaCodeRequest takes exactly one of totpCode / recoveryCode, never plain `code`', () => {
    expect(Value.Check(MfaCodeRequest, { totpCode: '123456' })).toBe(true);
    expect(Value.Check(MfaCodeRequest, { recoveryCode: 'abcde-fgh23' })).toBe(true);
    for (const bad of [
      {},
      { code: '123456' },
      { totpCode: '12345' },
      { totpCode: '1234567' },
      { totpCode: 'abcdef' },
      { totpCode: '123456', recoveryCode: 'abcde-fgh23' },
      { recoveryCode: 'abc' },
      { recoveryCode: 'abcde-fgh01' },
    ])
      expect(Value.Check(MfaCodeRequest, bad), JSON.stringify(bad)).toBe(false);
  });

  it('confirm needs the factor id and a 6-digit code', () => {
    expect(Value.Check(MfaTotpConfirmRequest, { factorId: id, totpCode: '000000' })).toBe(true);
    expect(Value.Check(MfaTotpConfirmRequest, { totpCode: '000000' })).toBe(false);
    expect(Value.Check(MfaTotpConfirmRequest, { factorId: id, totpCode: '000000', x: 1 })).toBe(
      false,
    );
  });

  it('enroll / recovery / status / elevation responses validate', () => {
    expect(
      Value.Check(MfaTotpEnrollResponse, {
        factorId: id,
        totpSecret: 'A'.repeat(32),
        otpauthUri: 'otpauth://totp/MeetOps:a?issuer=MeetOps',
        expiresAt: at,
      }),
    ).toBe(true);
    const codes = Array.from({ length: 10 }, (_, i) => `abcde-fgh${i + 2}${i + 2}`.slice(0, 11));
    expect(Value.Check(MfaRecoveryCodesResponse, { recoveryCodes: codes })).toBe(true);
    expect(Value.Check(MfaRecoveryCodesResponse, { recoveryCodes: codes.slice(1) })).toBe(false);
    expect(
      Value.Check(MfaStatusResponse, {
        enabled: true,
        factors: [
          { id, type: 'totp', status: 'active', createdAt: at, confirmedAt: at, lastUsedAt: null },
        ],
        recoveryCodesRemaining: 10,
      }),
    ).toBe(true);
    expect(
      Value.Check(MfaElevationResponse, { csrfToken: csrf, authLevel: 'mfa', stepUpExpiresAt: at }),
    ).toBe(true);
    expect(
      Value.Check(MfaElevationResponse, {
        csrfToken: csrf,
        authLevel: 'root',
        stepUpExpiresAt: null,
      }),
    ).toBe(false);
  });

  it('AuthSession gains optional session info and has no mfaRequired flag (OQ-17: never a half session)', () => {
    const base = {
      user: {
        id,
        email: 'a@example.com',
        name: 'Ada',
        emailVerifiedAt: null,
        createdAt: at,
        updatedAt: at,
      },
      csrfToken: csrf,
      activeOrganizationId: null,
      role: null,
      organizations: [],
    };
    expect(Value.Check(AuthSession, base)).toBe(true);
    expect(Object.keys(AuthSession.properties)).not.toContain('mfaRequired');
    expect(
      Value.Check(AuthSession, { ...base, session: { authLevel: 'password', mfaEnabled: false } }),
    ).toBe(true);
    expect(
      Value.Check(AuthSession, {
        ...base,
        session: { authLevel: 'mfa', mfaEnabled: true, stepUpExpiresAt: null },
      }),
    ).toBe(true);
    expect(
      Value.Check(AuthSession, { ...base, session: { authLevel: 'nope', mfaEnabled: true } }),
    ).toBe(false);
    const noCsrf: Partial<typeof base> = { ...base };
    delete noCsrf.csrfToken;
    expect(Value.Check(GetAuthSessionResponse, noCsrf)).toBe(true);
    expect(Object.keys(GetAuthSessionResponse.properties)).not.toContain('mfaRequired');
    // The challenge response is the session created by the challenge.
    expect(MfaChallengeResponse).toBe(AuthSession);
  });

  describe('OQ-17 login MFA challenge (not a session)', () => {
    const challengeToken = 'A'.repeat(43);
    const challenge = { mfaRequired: true, challengeToken, expiresAt: at };

    it('MfaLoginChallenge is exactly { mfaRequired: true, challengeToken, expiresAt }', () => {
      expect(Value.Check(MfaLoginChallenge, challenge)).toBe(true);
      expect(Object.keys(MfaLoginChallenge.properties).sort()).toEqual(
        ['challengeToken', 'expiresAt', 'mfaRequired'].sort(),
      );
      expect(Value.Check(MfaLoginChallenge, { ...challenge, mfaRequired: false })).toBe(false);
      // No session material can ride along: no CSRF token, no user, no org data.
      for (const extra of [{ csrfToken: csrf }, { user: { id } }, { organizations: [] }])
        expect(Value.Check(MfaLoginChallenge, { ...challenge, ...extra })).toBe(false);
      expect(Value.Check(MfaLoginChallenge, { ...challenge, challengeToken: 'short' })).toBe(false);
      expect(
        Value.Check(MfaLoginChallenge, { ...challenge, challengeToken: 'a b'.repeat(20) }),
      ).toBe(false);
    });

    it('LoginResponse is a session or a challenge, discriminated on mfaRequired', () => {
      expect(Value.Check(LoginResponse, challenge)).toBe(true);
      expect(
        Value.Check(LoginResponse, {
          user: {
            id,
            email: 'a@example.com',
            name: 'Ada',
            emailVerifiedAt: null,
            createdAt: at,
            updatedAt: at,
          },
          csrfToken: csrf,
          activeOrganizationId: null,
          role: null,
          organizations: [],
        }),
      ).toBe(true);
    });

    it('MfaChallengeRequest needs the challenge token plus exactly one code', () => {
      expect(Value.Check(MfaChallengeRequest, { challengeToken, totpCode: '123456' })).toBe(true);
      expect(
        Value.Check(MfaChallengeRequest, { challengeToken, recoveryCode: 'abcde-fghij' }),
      ).toBe(true);
      expect(Value.Check(MfaChallengeRequest, { totpCode: '123456' })).toBe(false);
      expect(Value.Check(MfaChallengeRequest, { challengeToken })).toBe(false);
      expect(
        Value.Check(MfaChallengeRequest, {
          challengeToken,
          totpCode: '123456',
          recoveryCode: 'abcde-fghij',
        }),
      ).toBe(false);
    });

    it('5-minute TTL, single purpose, and the token is a REDACT key', () => {
      expect(MFA_CHALLENGE_TTL_SECONDS).toBe(300);
      expect(MFA_CHALLENGE_PURPOSE).toBe('mfa_challenge');
      expect(REDACT_KEYS as readonly string[]).toContain('challengeToken');
    });
  });

  it('MFA body/response fields are REDACT_KEYS', () => {
    for (const k of ['totpCode', 'recoveryCode', 'recoveryCodes', 'otpauthUri', 'totpSecret'])
      expect(REDACT_KEYS as readonly string[]).toContain(k);
    // Narrowed (review #497 g): no bare `secret` entry in the contracts list.
    expect(REDACT_KEYS as readonly string[]).not.toContain('secret');
  });
});
