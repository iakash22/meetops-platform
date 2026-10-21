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

export type SignupBodyT = Static<typeof SignupBody>;
export type LoginBodyT = Static<typeof LoginBody>;
export type ForgotPasswordBodyT = Static<typeof ForgotPasswordBody>;
export type ResetPasswordBodyT = Static<typeof ResetPasswordBody>;
export type SessionResponseT = Static<typeof SessionResponse>;
export type GetSessionResponseT = Static<typeof GetSessionResponse>;
