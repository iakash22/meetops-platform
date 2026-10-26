import { Type, type Static } from '@sinclair/typebox';
import {
  AuthSession,
  CsrfResponse,
  ForgotPasswordRequest,
  GetAuthSessionResponse,
  Id,
  ListSessionsResponse,
  LoginRequest,
  ResetPasswordRequest,
  SignupRequest,
  VerifyEmailRequest,
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

export const VerifyEmailBody = VerifyEmailRequest;
export const ResendVerificationBody = ForgotPasswordRequest;
export const SessionIdParams = Type.Object({ sessionId: Id });

/** Contracts v0.3.1: strict SessionSummary cursor page (no token material, ip <= 45, userAgent <= 1024). */
export const SessionList = ListSessionsResponse;

export type VerifyEmailBodyT = Static<typeof VerifyEmailBody>;
export type SessionIdParamsT = Static<typeof SessionIdParams>;
export type SignupBodyT = Static<typeof SignupBody>;
export type LoginBodyT = Static<typeof LoginBody>;
export type ForgotPasswordBodyT = Static<typeof ForgotPasswordBody>;
export type ResetPasswordBodyT = Static<typeof ResetPasswordBody>;
export type SessionResponseT = Static<typeof SessionResponse>;
export type GetSessionResponseT = Static<typeof GetSessionResponse>;
