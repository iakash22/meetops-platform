import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { Membership, Organization, Role, User } from '../domain/org.js';

const Email = Type.String({ format: 'email', maxLength: 320 });
/** Minimum 12 characters (security review of PR #17). */
const Password = Type.String({ minLength: 12, maxLength: 128 });
const strict = { additionalProperties: false } as const;

export const LoginRequest = Type.Object({ email: Email, password: Password }, strict);
export type LoginRequest = Static<typeof LoginRequest>;

export const SignupRequest = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 200 }), email: Email, password: Password },
  strict,
);
export type SignupRequest = Static<typeof SignupRequest>;

export const ForgotPasswordRequest = Type.Object({ email: Email }, strict);
export type ForgotPasswordRequest = Static<typeof ForgotPasswordRequest>;

/**
 * Returned by login/signup/session endpoints.
 *
 * There is no bearer token in the body. The session lives only in a
 * `__Host-` prefixed, HttpOnly, Secure, SameSite cookie set by the API.
 * Clients send `csrfToken` back in the `x-csrf-token` header on state-changing requests.
 * `activeOrganizationId` and `role` are set by the server from the membership, never by the client. Both are null when the user has no organization membership yet (both null or both set).
 */
export const AuthSession = Type.Object({
  user: User,
  csrfToken: Type.String({ minLength: 16 }),
  activeOrganizationId: Type.Union([Id, Type.Null()]),
  role: Type.Union([Role, Type.Null()]),
  expiresAt: Type.Optional(IsoDateTime),
  organizations: Type.Array(Organization),
  memberships: Type.Optional(Type.Array(Membership)),
});
export type AuthSession = Static<typeof AuthSession>;

/** GET /auth/session: the current session without any token material. */
export const GetAuthSessionResponse = Type.Omit(AuthSession, ['csrfToken']);
export type GetAuthSessionResponse = Static<typeof GetAuthSessionResponse>;

/** GET /auth/csrf */
export const CsrfResponse = Type.Object({ csrfToken: Type.String({ minLength: 16 }) });
export type CsrfResponse = Static<typeof CsrfResponse>;

/** Alias used by Backend. */
export const GetAuthSession = GetAuthSessionResponse;
export type GetAuthSession = GetAuthSessionResponse;

/** Single-use, opaque token from the emailed link (never logged). */
const OpaqueToken = Type.String({ minLength: 32, maxLength: 512 });

/** POST /auth/reset-password */
export const ResetPasswordRequest = Type.Object({ token: OpaqueToken, password: Password }, strict);
export type ResetPasswordRequest = Static<typeof ResetPasswordRequest>;

/** POST /auth/verify-email */
export const VerifyEmailRequest = Type.Object({ token: OpaqueToken }, strict);
export type VerifyEmailRequest = Static<typeof VerifyEmailRequest>;
