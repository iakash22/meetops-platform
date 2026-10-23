import { DomainError } from '../../../shared/domain-error.js';

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}
/** Unknown and non-member orgs are indistinguishable (multi-tenant-isolation.md §4). */
export class OrganizationNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Organization not found', 404);
  }
}
