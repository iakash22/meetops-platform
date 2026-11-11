import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as Light from '../src/types.js';
import {
  API_ERROR_CODES,
  ApiErrorCode,
  AuthSession,
  GetAuthSessionResponse,
  MFA_PATHS,
  MfaCodeRequest,
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
        secret: 'A'.repeat(32),
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

  it('AuthSession gains optional mfaRequired and session info (older servers stay valid)', () => {
    const base = {
      user: {
        id,
        email: 'a@example.com',
        name: null,
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
    expect(
      Value.Check(AuthSession, {
        ...base,
        mfaRequired: true,
        session: { authLevel: 'password', mfaEnabled: true },
      }),
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
    expect(Value.Check(GetAuthSessionResponse, { ...noCsrf, mfaRequired: false })).toBe(true);
  });

  it('MFA body/response fields are REDACT_KEYS', () => {
    for (const k of ['totpCode', 'recoveryCode', 'recoveryCodes', 'otpauthUri', 'secret'])
      expect(REDACT_KEYS as readonly string[]).toContain(k);
  });
});
