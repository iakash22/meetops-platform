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
/**
 * A credential store step (takeover transaction or its follow-up revocations) failed: 503 + Retry-After rather than a
 * generic 500. The state is consistent either way (OIDC review: the claim is one transaction; follow-ups are retried).
 */
export class CredentialStoreUnavailableError extends DomainError {
  readonly retryAfterMs = 5_000;
  constructor() {
    super('PROVIDER_UNAVAILABLE', 'Service temporarily unavailable, try again later', 503);
  }
}
/** Platform error (shared/rate-limit-core.ts), re-exported so `instanceof` stays one class everywhere. */
export { RateLimitedError } from '../../../shared/rate-limit-core.js';
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
