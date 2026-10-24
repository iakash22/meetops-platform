import { ApiError, type ApiErrorCode } from '@/lib/api/client';

/**
 * Pairing-specific, user-facing text for POST /auth/extension/pair failures. Server messages are never shown.
 *
 * TODO(contracts): the contract only exposes the generic ApiErrorEnvelope codes. There is no dedicated code for
 * "extension not allowlisted", "nonce already used" or "pairing code expired", so those are inferred from the
 * generic codes below (FORBIDDEN / CONFLICT). Replace once the contract adds pairing-specific codes or `details`.
 */
export type PairFailure = {
  title: string;
  message: string;
  /** Whether re-POSTing with the same link can help. Otherwise the user must restart from the extension. */
  retryable: boolean;
  requestId?: string;
};

const RESTART = 'Start pairing again from the MeetOps extension.';

const BY_CODE: Record<ApiErrorCode, Omit<PairFailure, 'requestId'>> = {
  BAD_REQUEST: {
    title: 'Invalid pairing link',
    message: `This pairing link isn't valid. ${RESTART}`,
    retryable: false,
  },
  VALIDATION_FAILED: {
    title: 'Invalid pairing link',
    message: `This pairing link isn't valid. ${RESTART}`,
    retryable: false,
  },
  UNAUTHENTICATED: {
    title: 'Signed out',
    message: 'Your session ended. Sign in again, then retry.',
    retryable: false,
  },
  AUTH_FAILED: {
    title: 'Signed out',
    message: 'Your session ended. Sign in again, then retry.',
    retryable: false,
  },
  CSRF_INVALID: {
    title: 'Security check expired',
    message: 'Refresh this page, then try again.',
    retryable: false,
  },
  FORBIDDEN: {
    title: 'Pairing not allowed',
    message:
      "This extension or organization can't be paired with your account. Contact your admin if this seems wrong.",
    retryable: false,
  },
  NOT_FOUND: {
    title: 'Pairing link expired',
    message: `This pairing request is no longer valid. ${RESTART}`,
    retryable: false,
  },
  CONFLICT: {
    title: 'Pairing link already used',
    message: `This pairing link was already used or has expired. ${RESTART}`,
    retryable: false,
  },
  RATE_LIMITED: {
    title: 'Too many attempts',
    message: 'Please wait a moment, then try again.',
    retryable: true,
  },
  PROVIDER_UNAVAILABLE: {
    title: 'Service unavailable',
    message: 'A service we depend on is unavailable. Try again shortly.',
    retryable: true,
  },
  INTERNAL: {
    title: 'Pairing failed',
    message: 'Something went wrong on our side. Try again.',
    retryable: true,
  },
  UNKNOWN: {
    title: 'Pairing failed',
    message: 'Something went wrong. Try again.',
    retryable: true,
  },
};

export function describePairError(error: unknown): PairFailure {
  if (error instanceof ApiError) {
    return { ...BY_CODE[error.code], ...(error.requestId ? { requestId: error.requestId } : {}) };
  }
  return { ...BY_CODE.UNKNOWN };
}

/** True if the server's `expiresAt` (ExtensionPairResponse) is unparseable or already in the past. */
export function isPairingCodeExpired(expiresAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) || t <= now;
}
