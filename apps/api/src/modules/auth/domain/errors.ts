import { DomainError } from '../../../shared/domain-error.js';

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('AUTH_FAILED', 'Invalid email or password', 401);
  }
}
export class UnauthenticatedError extends DomainError {
  constructor() {
    super('UNAUTHENTICATED', 'Authentication required', 401);
  }
}
export class RateLimitedError extends DomainError {
  constructor(public readonly retryAfterMs: number) {
    super('RATE_LIMITED', 'Too many requests, try again later', 429);
  }
}
/** Missing, mismatched, forged or stale CSRF token. */
export class CsrfError extends DomainError {
  constructor(message = 'CSRF validation failed') {
    super('CSRF_INVALID', message, 403);
  }
}
/** Origin check failure stays a plain FORBIDDEN. */
export class OriginForbiddenError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'Origin not allowed', 403);
  }
}
