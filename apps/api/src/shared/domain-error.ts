import type { ApiErrorCode, ApiErrorReason } from './api-error.js';

/** Base error for domain/application rules. Mapped to the contracts error envelope by route handlers. */
export class DomainError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    /** Sub-reason sent as `error.reason`. 409s without one get the generic 'CONFLICT'. */
    public readonly reason?: ApiErrorReason,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
