import type { ApiErrorCode, ConflictReason } from '@meetops/contracts';

import { AuthError, type AuthClient, type DesktopSession } from '@/features/auth/auth-client';

/**
 * IPC surface the Rust auth module exposes (ADR-012 Decision 3.3). The webview only ever sees token-free data:
 *
 *   auth_sign_in   ()                         -> DesktopSession   (browser + PKCE + loopback, keychain write)
 *   auth_session   ()                         -> DesktopSession | null
 *   auth_sign_out  ()                         -> void             (revoke, then keychain delete even offline)
 *   api_request    { method, path, body? }    -> unknown          (Rust attaches the bearer; API origin + scoped routes only)
 *
 * Errors are serialized as `{ code: ApiErrorCode, message, reason? }`.
 * RUST DEPENDENCY: these commands need `keyring` and the opener plugin, which change Cargo.lock; they wait for the
 * lockfile slot and ADR-012 sign-off.
 */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface NativeCommandError {
  code: ApiErrorCode;
  message: string;
  reason?: ConflictReason;
}

const API_ERROR_CODES: ReadonlySet<string> = new Set([
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'AUTH_FAILED',
  'CSRF_INVALID',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
]);

/** Keys that must never cross IPC into the webview (ADR-012 Decision 3.3, "no token in any IPC payload"). */
const SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'authorization',
  'code',
  'codeverifier',
  'code_verifier',
  'state',
]);

function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, depth + 1));
  return Object.entries(value).some(
    ([k, v]) => SECRET_KEYS.has(k.toLowerCase()) || containsSecret(v, depth + 1),
  );
}

export function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const e = error as NativeCommandError;
    if (API_ERROR_CODES.has(e.code)) return new AuthError(e.code, String(e.message), e.reason);
  }
  // Unknown command (Rust side not shipped) or an IPC failure. Never echo raw native text to the UI.
  return new AuthError('INTERNAL', 'Desktop sign-in is not available in this build.');
}

/** Invokes a command and refuses any response that would leak a credential into the webview. */
export async function invokeTokenFree<T>(
  invoke: Invoke,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  let result: T;
  try {
    result = await invoke<T>(cmd, args);
  } catch (e) {
    throw toAuthError(e);
  }
  if (containsSecret(result)) throw new AuthError('INTERNAL', 'Refused an unsafe native response.');
  return result;
}

export function createNativeAuthClient(invoke: Invoke): AuthClient {
  const notSupported = () =>
    Promise.reject(new AuthError('BAD_REQUEST', 'Use "Sign in with your browser".'));
  return {
    signIn: notSupported,
    signUp: notSupported,
    signInWithBrowser: () => invokeTokenFree<DesktopSession>(invoke, 'auth_sign_in'),
    restore: async () => {
      try {
        return await invokeTokenFree<DesktopSession | null>(invoke, 'auth_session');
      } catch (e) {
        // A dead family means "signed out", not an error screen (ADR-012 Decision 4.1).
        if (e instanceof AuthError && e.code === 'UNAUTHENTICATED') return null;
        throw e;
      }
    },
    signOut: async () => {
      await invokeTokenFree<void>(invoke, 'auth_sign_out');
    },
  };
}
