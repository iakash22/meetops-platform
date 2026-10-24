import { Type, type Static } from '@sinclair/typebox';

/**
 * Error codes. There are deliberately no codes that reveal whether an account exists
 * (no USER_EXISTS / EMAIL_NOT_FOUND). Login, signup and password-reset failures use
 * AUTH_FAILED, or a generic 2xx for forgot-password.
 *
 * Tenancy: accessing a resource in another organization returns NOT_FOUND (never FORBIDDEN),
 * so ids from other tenants cannot be probed.
 */
export const ApiErrorCode = Type.Union([
  Type.Literal('BAD_REQUEST'),
  Type.Literal('VALIDATION_FAILED'),
  Type.Literal('UNAUTHENTICATED'),
  Type.Literal('AUTH_FAILED'),
  /** Missing or mismatched x-csrf-token. The client should GET /auth/csrf and retry once. */
  Type.Literal('CSRF_INVALID'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('CONFLICT'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('PROVIDER_UNAVAILABLE'),
  Type.Literal('INTERNAL'),
]);
export type ApiErrorCode = Static<typeof ApiErrorCode>;
export { API_ERROR_CODES } from '../constants.js';
import { CONFLICT_REASONS } from '../constants.js';
export { CONFLICT_REASONS, CONFLICT_HTTP_STATUS, API_ERROR_REASONS } from '../constants.js';

/** Named reason for a `CONFLICT` (409) error. See CONFLICT_REASONS. */
export const ConflictReason = Type.Union(CONFLICT_REASONS.map((r) => Type.Literal(r)));
export type ConflictReason = (typeof CONFLICT_REASONS)[number];
/** Alias of ConflictReason: the `error.reason` schema of ApiErrorEnvelope. */
export const ApiErrorReason = ConflictReason;
export type ApiErrorReason = ConflictReason;

/**
 * `message` is safe and generic for display. It must not contain stack traces, SQL, provider
 * errors, or other tenants' data. `requestId` is always present so support can correlate logs.
 */
export const ApiErrorEnvelope = Type.Object({
  error: Type.Object({
    code: ApiErrorCode,
    message: Type.String({ maxLength: 500 }),
    requestId: Type.String({ minLength: 1 }),
    /** v0.3.3: only with `code: 'CONFLICT'` (409). Optional so older servers stay valid. */
    reason: Type.Optional(ConflictReason),
    details: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), message: Type.String({ maxLength: 500 }) })),
    ),
  }),
});
export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelope>;

/** A 409 body: `code` is `CONFLICT` and `reason` is required. */
export type ConflictErrorEnvelope = {
  error: Omit<ApiErrorEnvelope['error'], 'code' | 'reason'> & { code: 'CONFLICT'; reason: ConflictReason };
};
