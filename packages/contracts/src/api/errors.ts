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
  Type.Literal('FORBIDDEN'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('CONFLICT'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('PROVIDER_UNAVAILABLE'),
  Type.Literal('INTERNAL'),
]);
export type ApiErrorCode = Static<typeof ApiErrorCode>;

/**
 * `message` is safe and generic for display. It must not contain stack traces, SQL, provider
 * errors, or other tenants' data. `requestId` is always present so support can correlate logs.
 */
export const ApiErrorEnvelope = Type.Object({
  error: Type.Object({
    code: ApiErrorCode,
    message: Type.String({ maxLength: 500 }),
    requestId: Type.String({ minLength: 1 }),
    details: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), message: Type.String({ maxLength: 500 }) })),
    ),
  }),
});
export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelope>;
