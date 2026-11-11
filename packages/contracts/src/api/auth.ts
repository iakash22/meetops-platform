import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { Membership, Organization, Role, User } from '../domain/org.js';
import { AuthSessionInfo } from './mfa.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_PATTERN } from '../password-policy.js';

const Email = Type.String({ format: 'email', maxLength: 320 });

// Password policy lives in a TypeBox-free module so UI bundles can import it from `@meetops/contracts/types`.
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_PATTERN,
  PASSWORD_POLICY_MESSAGE,
  isAcceptablePassword,
} from '../password-policy.js';

const Password = Type.String({
  minLength: PASSWORD_MIN_LENGTH,
  maxLength: PASSWORD_MAX_LENGTH,
  pattern: PASSWORD_PATTERN,
});
/** Login accepts any non-empty password (max 128) so the policy is not revealed and legacy users are not locked out. */
const LoginPassword = Type.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH });
const strict = { additionalProperties: false } as const;

export const LoginRequest = Type.Object({ email: Email, password: LoginPassword }, strict);
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
 * `activeOrganizationId` and `role` are set by the server from the membership, never by the client. Both are null when the user has no organization membership yet (both null or both set), or while `mfaRequired`.
 */
export const AuthSession = Type.Object({
  user: User,
  csrfToken: Type.String({ minLength: 16 }),
  activeOrganizationId: Type.Union([Id, Type.Null()]),
  role: Type.Union([Role, Type.Null()]),
  expiresAt: Type.Optional(IsoDateTime),
  organizations: Type.Array(Organization),
  memberships: Type.Optional(Type.Array(Membership)),
  /**
   * Unreleased (ADR-021): true when the user has MFA on and this session has not passed POST /auth/mfa/challenge.
   * Org data is then withheld (`organizations: []`, nulls) and org routes return 403 MFA_REQUIRED.
   */
  mfaRequired: Type.Optional(Type.Boolean()),
  /** Unreleased (ADR-021): assurance level of the current session. */
  session: Type.Optional(AuthSessionInfo),
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

/**
 * Body of `POST /orgs/switch` (the API route is the source of truth; there is no `/auth/switch-org`). The caller must
 * be a member (otherwise NOT_FOUND). The response is `{ organization, role }` for the new active organization, with
 * `role` re-derived from the membership. The server **rotates the session id** (new `__Host-` cookie, old one
 * invalidated) and issues a **fresh CSRF token** for the new session; read the session again with `GET /auth/session`
 * if you need the full `AuthSession`. (Desktop tokens use `POST /auth/desktop/switch-org`, ADR-012.)
 */
export const SwitchOrganizationRequest = Type.Object({ organizationId: Id }, strict);
export type SwitchOrganizationRequest = Static<typeof SwitchOrganizationRequest>;
