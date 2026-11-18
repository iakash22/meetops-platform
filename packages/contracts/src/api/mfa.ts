import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { MFA_RECOVERY_CODE_COUNT, SESSION_AUTH_LEVELS } from '../constants.js';

export {
  MFA_PATHS,
  SESSION_AUTH_LEVELS,
  MFA_STEP_UP_WINDOW_SECONDS,
  MFA_TOTP_DIGITS,
  MFA_TOTP_PERIOD_SECONDS,
  MFA_RECOVERY_CODE_COUNT,
} from '../constants.js';

const strict = { additionalProperties: false } as const;

/** Session assurance level. `mfa` only after a TOTP or recovery-code check on this session (ADR-021 D4). */
export const SessionAuthLevel = Type.Union(SESSION_AUTH_LEVELS.map((l) => Type.Literal(l)));
export type SessionAuthLevel = (typeof SESSION_AUTH_LEVELS)[number];

/** Six ASCII digits. Never logged (`totpCode` is a REDACT key). */
export const TotpCode = Type.String({ pattern: '^[0-9]{6}$', minLength: 6, maxLength: 6 });
/** Recovery code as shown (`xxxxx-xxxxx`); case, spaces and dashes are ignored. Never logged. */
export const RecoveryCode = Type.String({
  minLength: 10,
  maxLength: 32,
  pattern: '^[A-Za-z2-7 -]+$',
});

/** Exactly one of `totpCode` / `recoveryCode`; the server returns INVALID_MFA_CODE (generic) when wrong. */
export const MfaCodeRequest = Type.Union([
  Type.Object({ totpCode: TotpCode }, strict),
  Type.Object({ recoveryCode: RecoveryCode }, strict),
]);
export type MfaCodeRequest = Static<typeof MfaCodeRequest>;

/** POST /auth/mfa/challenge: finish login for an MFA user. */
export const MfaChallengeRequest = MfaCodeRequest;
export type MfaChallengeRequest = MfaCodeRequest;
/** POST /auth/mfa/step-up: same body; refreshes step-up freshness. */
export const MfaStepUpRequest = MfaCodeRequest;
export type MfaStepUpRequest = MfaCodeRequest;
/** POST /auth/mfa/recovery-codes and DELETE /auth/mfa/factors/:factorId: no body (step-up gates them). */
export const MfaFactorParams = Type.Object({ factorId: Id }, strict);
export type MfaFactorParams = Static<typeof MfaFactorParams>;

/** POST /auth/mfa/totp/confirm */
export const MfaTotpConfirmRequest = Type.Object({ factorId: Id, totpCode: TotpCode }, strict);
export type MfaTotpConfirmRequest = Static<typeof MfaTotpConfirmRequest>;

/** A factor as the owner sees it. Never contains the secret. */
export const MfaFactor = Type.Object({
  id: Id,
  type: Type.Literal('totp'),
  status: Type.Union([Type.Literal('pending'), Type.Literal('active')]),
  createdAt: IsoDateTime,
  confirmedAt: Type.Union([IsoDateTime, Type.Null()]),
  lastUsedAt: Type.Union([IsoDateTime, Type.Null()]),
});
export type MfaFactor = Static<typeof MfaFactor>;

/** GET /auth/mfa */
export const MfaStatusResponse = Type.Object({
  enabled: Type.Boolean(),
  factors: Type.Array(MfaFactor),
  recoveryCodesRemaining: Type.Integer({ minimum: 0, maximum: MFA_RECOVERY_CODE_COUNT }),
});
export type MfaStatusResponse = Static<typeof MfaStatusResponse>;

/**
 * POST /auth/mfa/totp/enroll. Shown once; the response has `Cache-Control: no-store`. `secret` is the base32 secret for
 * manual entry; `otpauthUri` is for the QR code. Both are REDACT keys. The factor stays `pending` until confirm and
 * expires after `expiresAt`.
 */
export const MfaTotpEnrollResponse = Type.Object({
  factorId: Id,
  secret: Type.String({ minLength: 16, maxLength: 64 }),
  otpauthUri: Type.String({ minLength: 1, maxLength: 1024 }),
  expiresAt: IsoDateTime,
});
export type MfaTotpEnrollResponse = Static<typeof MfaTotpEnrollResponse>;

/** Recovery codes, shown once (`Cache-Control: no-store`). Only HMACs are stored server-side. */
export const MfaRecoveryCodesResponse = Type.Object({
  recoveryCodes: Type.Array(Type.String({ minLength: 10, maxLength: 16 }), {
    minItems: MFA_RECOVERY_CODE_COUNT,
    maxItems: MFA_RECOVERY_CODE_COUNT,
  }),
});
export type MfaRecoveryCodesResponse = Static<typeof MfaRecoveryCodesResponse>;

/** POST /auth/mfa/totp/confirm: the factor is active and the session is elevated; recovery codes are shown once. */
export const MfaTotpConfirmResponse = Type.Object({
  factor: MfaFactor,
  recoveryCodes: MfaRecoveryCodesResponse.properties.recoveryCodes,
  csrfToken: Type.String({ minLength: 16 }),
});
export type MfaTotpConfirmResponse = Static<typeof MfaTotpConfirmResponse>;

/** Challenge / step-up success: the session id rotated, so a new CSRF token comes back. */
export const MfaElevationResponse = Type.Object({
  csrfToken: Type.String({ minLength: 16 }),
  authLevel: SessionAuthLevel,
  stepUpExpiresAt: Type.Union([IsoDateTime, Type.Null()]),
  recoveryCodesRemaining: Type.Optional(
    Type.Integer({ minimum: 0, maximum: MFA_RECOVERY_CODE_COUNT }),
  ),
});
export type MfaElevationResponse = Static<typeof MfaElevationResponse>;

/** `AuthSession.session`: assurance info for the current session (ADR-021). */
export const AuthSessionInfo = Type.Object({
  authLevel: SessionAuthLevel,
  mfaEnabled: Type.Boolean(),
  /** When the current step-up stops being fresh; null when there is none. */
  stepUpExpiresAt: Type.Optional(Type.Union([IsoDateTime, Type.Null()])),
});
export type AuthSessionInfo = Static<typeof AuthSessionInfo>;
