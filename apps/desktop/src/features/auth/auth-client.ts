import type {
  ApiErrorCode,
  ConflictReason,
  GetAuthSessionResponse,
  LoginRequest,
  SignupRequest,
} from '@meetops/contracts';

/**
 * Desktop session as held in memory. Uses the contracts' token-free session shape: the M1 shell never sees
 * or stores a token. The real desktop auth flow (bearer + pairing per an ADR-005-style decision, tokens in
 * the OS keychain via the Rust side) is an owner/Architecture decision and is NOT implemented here.
 */
export type DesktopSession = GetAuthSessionResponse;

export class AuthError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly reason?: ConflictReason,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Minimum password length for new accounts (contracts SignupRequest: minLength 12). */
export const MIN_PASSWORD_LENGTH = 12;
/** Max password length (contracts SignupRequest / LoginRequest). */
export const MAX_PASSWORD_LENGTH = 128;
/** Max display name length (contracts SignupRequest.name). */
export const MAX_NAME_LENGTH = 200;

/**
 * POST /auth/signup answers 202 with no session: the account is only usable after the emailed
 * verification link is opened, so the UI shows a "check your email" state and never signs in.
 */
export interface SignUpResult {
  status: 'verification_sent';
  email: string;
}

export interface AuthClient {
  signIn: (request: LoginRequest) => Promise<DesktopSession>;
  signUp: (request: SignupRequest) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
}
