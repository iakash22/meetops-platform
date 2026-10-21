import { Type, type Static } from '@sinclair/typebox';
import {
  AuthSession,
  CsrfResponse,
  ForgotPasswordRequest,
  GetAuthSessionResponse,
  LoginRequest,
  ResetPasswordRequest,
  SignupRequest
} from '@meetops/contracts';
import { ApiErrorEnvelope } from '../../../shared/api-error.js';

/** Contracts envelope + CSRF_INVALID (see shared/api-error.ts). */
export const ErrorBody = ApiErrorEnvelope;
export const AcceptedBody = Type.Object({ message: Type.String() });
export const CsrfBody = CsrfResponse;

export const SignupBody = SignupRequest;
export const LoginBody = LoginRequest;
export const ForgotPasswordBody = ForgotPasswordRequest;

export const ResetPasswordBody = ResetPasswordRequest;

export const SessionResponse = AuthSession;
export const GetSessionResponse = GetAuthSessionResponse;

/** TODO(contracts #38): replace with VerifyEmailRequest from @meetops/contracts. */
export const VerifyEmailBody = Type.Object(
  { token: Type.String({ minLength: 32, maxLength: 512 }) },
  { additionalProperties: false }
);
export const ResendVerificationBody = ForgotPasswordRequest;
export const SessionIdParams = Type.Object({ sessionId: Id });

/** Device/session list item. No token or hash material. */
export const SessionSummary = Type.Object(
  {
    id: Id,
    current: Type.Boolean(),
    createdAt: Type.String({ format: 'date-time' }),
    lastSeenAt: Type.String({ format: 'date-time' }),
    expiresAt: Type.String({ format: 'date-time' }),
    ip: Type.Union([Type.String(), Type.Null()]),
    userAgent: Type.Union([Type.String(), Type.Null()])
  },
  { additionalProperties: false }
);
export const SessionList = Type.Object({ items: Type.Array(SessionSummary) });

export type VerifyEmailBodyT = Static<typeof VerifyEmailBody>;
export type SessionIdParamsT = Static<typeof SessionIdParams>;
export type SignupBodyT = Static<typeof SignupBody>;
export type LoginBodyT = Static<typeof LoginBody>;
export type ForgotPasswordBodyT = Static<typeof ForgotPasswordBody>;
export type ResetPasswordBodyT = Static<typeof ResetPasswordBody>;
export type SessionResponseT = Static<typeof SessionResponse>;
export type GetSessionResponseT = Static<typeof GetSessionResponse>;
