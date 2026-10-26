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
import {
  API_ERROR_REASONS,
  CONFLICT_REASONS,
  CONSENT_ERROR_REASONS,
  NOT_FOUND_REASONS,
} from '../constants.js';
export {
  CONFLICT_REASONS,
  CONFLICT_HTTP_STATUS,
  API_ERROR_REASONS,
  NOT_FOUND_REASONS,
  NOT_FOUND_HTTP_STATUS,
  DIRECTORY_ERROR_REASONS,
} from '../constants.js';

/** Named reason for a `CONFLICT` (409) error. See CONFLICT_REASONS. */
export const ConflictReason = Type.Union(CONFLICT_REASONS.map((r) => Type.Literal(r)));
export type ConflictReason = (typeof CONFLICT_REASONS)[number];
/** v0.4.0: named reason for a `NOT_FOUND` (404) error. See NOT_FOUND_REASONS. */
export const NotFoundReason = Type.Union(NOT_FOUND_REASONS.map((r) => Type.Literal(r)));
export type NotFoundReason = (typeof NOT_FOUND_REASONS)[number];
/**
 * The `error.reason` schema of ApiErrorEnvelope: a ConflictReason, (v0.4.0) a NotFoundReason or (v0.4.1) a
 * ConsentErrorReason. Until v0.3.3 this was an alias of ConflictReason.
 */
export const ApiErrorReason = Type.Union(API_ERROR_REASONS.map((r) => Type.Literal(r)));
export type ApiErrorReason = (typeof API_ERROR_REASONS)[number];

/**
 * `message` is safe and generic for display. It must not contain stack traces, SQL, provider
 * errors, or other tenants' data. `requestId` is always present so support can correlate logs.
 */
export const ApiErrorEnvelope = Type.Object({
  error: Type.Object({
    code: ApiErrorCode,
    message: Type.String({ maxLength: 500 }),
    requestId: Type.String({ minLength: 1 }),
    /**
     * Optional so older servers stay valid. A ConflictReason only with `code: 'CONFLICT'` (409, v0.3.3); a
     * NotFoundReason only with `code: 'NOT_FOUND'` (404, v0.4.0); a ConsentErrorReason only with
     * `code: 'VALIDATION_FAILED'` (422, v0.4.1).
     */
    reason: Type.Optional(ApiErrorReason),
    details: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), message: Type.String({ maxLength: 500 }) })),
    ),
  }),
});
export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelope>;

/** A 409 body: `code` is `CONFLICT` and `reason` is required. */
export type ConflictErrorEnvelope = {
  error: Omit<ApiErrorEnvelope['error'], 'code' | 'reason'> & {
    code: 'CONFLICT';
    reason: ConflictReason;
  };
};

/** v0.4.0: a 404 body from a directory route: `code` is `NOT_FOUND` and `reason` is required. */
export type NotFoundErrorEnvelope = {
  error: Omit<ApiErrorEnvelope['error'], 'code' | 'reason'> & {
    code: 'NOT_FOUND';
    reason: NotFoundReason;
  };
};

/** v0.4.1: a 422 consent rejection body: `code` is `VALIDATION_FAILED` and `reason` is a ConsentErrorReason. */
export type ConsentErrorEnvelope = {
  error: Omit<ApiErrorEnvelope['error'], 'code' | 'reason'> & {
    code: 'VALIDATION_FAILED';
    reason: (typeof CONSENT_ERROR_REASONS)[number];
  };
};
