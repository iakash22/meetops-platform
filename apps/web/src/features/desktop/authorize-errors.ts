import { ApiError, type ApiErrorCode } from '@/lib/api/client';

/**
 * User-facing text for POST /auth/desktop/authorize failures. Server messages are never shown.
 * The route isn't served yet (ADR-012 is Proposed), so a 404 is expected until the API lands.
 */
export type DesktopAuthorizeFailure = {
  title: string;
  message: string;
  retryable: boolean;
  requestId?: string;
};

const RESTART = 'Start sign-in again from the MeetOps desktop app.';

const BY_CODE: Record<ApiErrorCode, Omit<DesktopAuthorizeFailure, 'requestId'>> = {
  BAD_REQUEST: {
    title: 'Invalid sign-in link',
    message: `This link isn't valid. ${RESTART}`,
    retryable: false,
  },
  VALIDATION_FAILED: {
    title: 'Invalid sign-in link',
    message: `This link isn't valid. ${RESTART}`,
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
    title: 'Desktop sign-in not allowed',
    message:
      "Your organization doesn't allow this device to sign in. Contact your admin if this seems wrong.",
    retryable: false,
  },
  NOT_FOUND: {
    title: 'Desktop sign-in unavailable',
    message: `Desktop sign-in isn't available on this server yet. ${RESTART}`,
    retryable: false,
  },
  CONFLICT: {
    title: 'Sign-in link already used',
    message: `This link was already used or has expired. ${RESTART}`,
    retryable: false,
  },
  MFA_REQUIRED: {
    title: 'Finish signing in',
    message: 'Enter the code from your authenticator app to finish signing in, then retry.',
    retryable: false,
  },
  STEP_UP_REQUIRED: {
    title: 'Confirm it is you',
    message: 'For desktop sign-in, confirm with your authenticator app, then retry.',
    retryable: true,
  },
  INVALID_MFA_CODE: {
    title: 'Code not accepted',
    message: "That authenticator code didn't work. Try again with a new code.",
    retryable: true,
  },
  PAYLOAD_TOO_LARGE: {
    title: 'Request too large',
    message: `This request was too large to process. ${RESTART}`,
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
    title: 'Desktop sign-in failed',
    message: 'Something went wrong on our side. Try again.',
    retryable: true,
  },
  UNKNOWN: {
    title: 'Desktop sign-in failed',
    message: "We couldn't reach MeetOps. Check your connection and try again.",
    retryable: true,
  },
};

export function describeDesktopAuthorizeError(error: unknown): DesktopAuthorizeFailure {
  if (error instanceof ApiError) {
    return { ...BY_CODE[error.code], ...(error.requestId ? { requestId: error.requestId } : {}) };
  }
  return { ...BY_CODE.UNKNOWN };
}
