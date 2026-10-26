import { AuthError, type AuthClient } from './auth-client';

/**
 * Used when the mock is off. Real desktop sign-in (ADR-012: system browser, PKCE, loopback, OS keychain) is not
 * implemented until the ADR is signed off, so every call fails closed. It never fakes a session.
 */
export function createUnavailableAuthClient(): AuthClient {
  const unavailable = () =>
    Promise.reject(
      new AuthError('INTERNAL', 'Desktop sign-in is not available yet in this build.'),
    );
  return { signIn: unavailable, signUp: unavailable, signOut: () => Promise.resolve() };
}
