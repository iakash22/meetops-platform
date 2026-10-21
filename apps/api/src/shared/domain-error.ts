import type { ApiErrorCode } from '@meetops/contracts';

/** Base error for domain/application rules. Mapped to the contracts error envelope by route handlers. */
export class DomainError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = new.target.name;
  }
}
