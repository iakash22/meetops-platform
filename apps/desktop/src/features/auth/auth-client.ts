import type { ApiErrorCode, GetAuthSessionResponse, LoginRequest } from '@meetops/contracts';

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
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthClient {
  signIn: (request: LoginRequest) => Promise<DesktopSession>;
  signOut: () => Promise<void>;
}
