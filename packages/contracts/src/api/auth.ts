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
 * `activeOrganizationId` and `role` are set by the server from the membership, never by the client.
 */
export const AuthSession = Type.Object({
  user: User,
  csrfToken: Type.String({ minLength: 16 }),
  activeOrganizationId: Id,
  role: Role,
  expiresAt: Type.Optional(IsoDateTime),
  organizations: Type.Array(Organization),
  memberships: Type.Optional(Type.Array(Membership)),
});
export type AuthSession = Static<typeof AuthSession>;
