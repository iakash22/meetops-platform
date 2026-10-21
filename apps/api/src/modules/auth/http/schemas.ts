import { Type, type Static } from '@sinclair/typebox';
import {
  ApiErrorEnvelope,
  AuthSession,
  CsrfResponse,
  ForgotPasswordRequest,
  Id,
  LoginRequest,
  Role,
  SignupRequest
} from '@meetops/contracts';

export const ErrorBody = ApiErrorEnvelope;
export const AcceptedBody = Type.Object({ message: Type.String() });
export const CsrfBody = CsrfResponse;

export const SignupBody = SignupRequest;
export const LoginBody = LoginRequest;
export const ForgotPasswordBody = ForgotPasswordRequest;

/** TODO(contracts v0.2): replace with ResetPasswordRequest (token 32-512, password 12-128) from @meetops/contracts. */
export const ResetPasswordBody = Type.Object(
  { token: Type.String({ minLength: 32, maxLength: 512 }), password: Type.String({ minLength: 12, maxLength: 128 }) },
  { additionalProperties: false }
);

/**
 * Contract AuthSession, except activeOrganizationId/role may be null for a user with no
 * organization yet. TODO(contracts): make these nullable in AuthSession, then use it directly.
 */
const NullableActive = Type.Object({
  activeOrganizationId: Type.Union([Id, Type.Null()]),
  role: Type.Union([Role, Type.Null()])
});
export const SessionResponse = Type.Composite([Type.Omit(AuthSession, ['activeOrganizationId', 'role']), NullableActive]);
export const GetSessionResponse = Type.Omit(SessionResponse, ['csrfToken']);

export type SignupBodyT = Static<typeof SignupBody>;
export type LoginBodyT = Static<typeof LoginBody>;
export type ForgotPasswordBodyT = Static<typeof ForgotPasswordBody>;
export type ResetPasswordBodyT = Static<typeof ResetPasswordBody>;
export type SessionResponseT = Static<typeof SessionResponse>;
export type GetSessionResponseT = Static<typeof GetSessionResponse>;
