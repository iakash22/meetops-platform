/** Base error for domain/application rules. Mapped to HTTP by route error handlers. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = new.target.name;
  }
}
