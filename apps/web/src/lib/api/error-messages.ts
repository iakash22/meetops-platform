import { ApiError, type ApiErrorCode } from './client';

/** Fixed, user-facing text per API error code. Server messages are never shown. */
export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  BAD_REQUEST: 'The request could not be processed.',
  VALIDATION_FAILED: 'Some of the information provided is invalid.',
  UNAUTHENTICATED: 'Please sign in to continue.',
  AUTH_FAILED: 'Invalid email or password.',
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "We couldn't find what you were looking for.",
  CONFLICT: 'This conflicts with an existing item.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  PROVIDER_UNAVAILABLE: 'A service we depend on is unavailable. Please try again later.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
  UNKNOWN: 'Something went wrong. Please try again.',
};

export function describeError(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    return {
      message: ERROR_MESSAGES[error.code],
      ...(error.requestId ? { requestId: error.requestId } : {}),
    };
  }
  return { message: ERROR_MESSAGES.UNKNOWN };
}
