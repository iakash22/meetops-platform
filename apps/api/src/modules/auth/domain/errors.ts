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
export class CsrfError extends DomainError {
  constructor(message = 'CSRF validation failed') {
    super('FORBIDDEN', message, 403);
  }
}
