import type {
  ApiErrorCode,
  ConflictReason,
  GetAuthSessionResponse,
  LoginRequest,
  SignupRequest,
} from '@meetops/contracts';

/**
 * Desktop session as held in memory. Uses the contracts' token-free session shape: the webview never sees or
 * stores a token. Per ADR-012 tokens live only on the Rust side (refresh token in the OS keychain, access token in
 * process memory) and the webview talks to narrow IPC commands (see `lib/native-auth.ts`).
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
  /** Mock preview only: the production desktop never collects a password (ADR-012 Option C rejected). */
  signIn: (request: LoginRequest) => Promise<DesktopSession>;
  signUp: (request: SignupRequest) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  /** ADR-012 Decision 1: opens the system browser and resolves after the PKCE exchange. */
  signInWithBrowser?: () => Promise<DesktopSession>;
  /** ADR-012 Decision 5.3: reloads the session on launch from the keychain-backed Rust side; null when signed out. */
  restore?: () => Promise<DesktopSession | null>;
}
