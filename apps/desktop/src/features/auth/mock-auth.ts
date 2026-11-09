import { isAcceptablePassword } from '@meetops/contracts/types';

import { AuthError, MAX_NAME_LENGTH, type AuthClient, type DesktopSession } from './auth-client';

/** Emails ending with this domain are rejected by the mock, to exercise the error path. */
export const MOCK_REJECT_DOMAIN = '@invalid.test';
/** Sign-ups with emails ending with this domain get the EMAIL_TAKEN conflict (the UI still shows "Check your email"). */
export const MOCK_TAKEN_DOMAIN = '@taken.test';
/** Sign-ups with emails ending with this domain fail with a non-field error, to exercise the toast. */
export const MOCK_DOWN_DOMAIN = '@unavailable.test';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NOW = '2026-01-01T00:00:00.000Z';
const MOCK_ORG_ID = '00000000-0000-4000-8000-000000000001';
const MOCK_USER_ID = '00000000-0000-4000-8000-000000000002';

function displayNameFrom(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/**
 * In-memory mock of the sign-in flow. It never contacts a server and never produces token material.
 * Any well-formed email with a non-empty password signs in, except `*@invalid.test` (AUTH_FAILED).
 * Sign-up mirrors POST /auth/signup: it resolves "verification sent" (202, no session) and never signs in;
 * `*@taken.test` is EMAIL_TAKEN and `*@unavailable.test` is a server error.
 */
export function createMockAuthClient({ delayMs = 300 }: { delayMs?: number } = {}): AuthClient {
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return {
    async signIn({ email, password }) {
      await wait();
      const normalized = email.trim().toLowerCase();
      if (!EMAIL_RE.test(normalized) || password.length === 0 || password.length > 128) {
        throw new AuthError('VALIDATION_FAILED', 'Enter a valid email and password.');
      }
      if (normalized.endsWith(MOCK_REJECT_DOMAIN)) {
        throw new AuthError('AUTH_FAILED', 'Email or password is incorrect.');
      }
      const session: DesktopSession = {
        user: {
          id: MOCK_USER_ID,
          email: normalized,
          name: displayNameFrom(normalized),
          createdAt: NOW,
          updatedAt: NOW,
        },
        activeOrganizationId: MOCK_ORG_ID,
        role: 'member',
        organizations: [
          {
            id: MOCK_ORG_ID,
            name: 'Demo Organization',
            slug: 'demo-org',
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      };
      return session;
    },
    async signUp({ name, email, password }) {
      await wait();
      const normalized = email.trim().toLowerCase();
      if (
        !name.trim() ||
        name.length > MAX_NAME_LENGTH ||
        !EMAIL_RE.test(normalized) ||
        !isAcceptablePassword(password)
      ) {
        throw new AuthError('VALIDATION_FAILED', 'Check the highlighted fields.');
      }
      if (normalized.endsWith(MOCK_TAKEN_DOMAIN)) {
        throw new AuthError(
          'CONFLICT',
          'An account with this email already exists.',
          'EMAIL_TAKEN',
        );
      }
      if (normalized.endsWith(MOCK_DOWN_DOMAIN)) {
        throw new AuthError('INTERNAL', 'Sign-up is unavailable right now. Try again shortly.');
      }
      return { status: 'verification_sent', email: normalized };
    },
    async signOut() {
      await wait();
    },
  };
}
