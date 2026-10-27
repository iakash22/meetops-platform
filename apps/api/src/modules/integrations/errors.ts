import { DomainError } from '../../shared/domain-error.js';

/** Unknown, malformed and other-org integration ids give the same 404 body. */
export class IntegrationNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Integration not found', 404);
  }
}
