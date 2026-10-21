import { Type, type Static } from '@sinclair/typebox';
import {
  ApiErrorEnvelope,
  ForgotPasswordRequest,
  LoginRequest,
  Membership,
  Organization,
  SignupRequest,
  User
} from '../../../shared/contracts/index.js';

export const ErrorBody = ApiErrorEnvelope;
export const AcceptedBody = Type.Object({ message: Type.String() });
export const CsrfBody = Type.Object({ csrfToken: Type.String() });

/** auth-session-spec §1: 12..128 chars. Stricter than the contract's 8..128. */
const NewPassword = Type.String({ minLength: 12, maxLength: 128 });

export const SignupBody = Type.Composite([Type.Omit(SignupRequest, ['password']), Type.Object({ password: NewPassword })], {
  additionalProperties: false
});
export const LoginBody = Type.Composite([LoginRequest], { additionalProperties: false });
export const ForgotPasswordBody = Type.Composite([ForgotPasswordRequest], { additionalProperties: false });
export const ResetPasswordBody = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: 256 }), password: NewPassword },
  { additionalProperties: false }
);

/**
 * Contract AuthSession minus `accessToken` (cookie-only sessions), plus session timing.
 * See "Deviations" in the PR body.
 */
export const SessionResponse = Type.Object({
  user: User,
  organizations: Type.Array(Organization),
  memberships: Type.Array(Membership),
  activeOrganizationId: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.String({ format: 'date-time' }),
  idleExpiresAt: Type.String({ format: 'date-time' })
});

export type SignupBodyT = Static<typeof SignupBody>;
export type LoginBodyT = Static<typeof LoginBody>;
export type ForgotPasswordBodyT = Static<typeof ForgotPasswordBody>;
export type ResetPasswordBodyT = Static<typeof ResetPasswordBody>;
export type SessionResponseT = Static<typeof SessionResponse>;
