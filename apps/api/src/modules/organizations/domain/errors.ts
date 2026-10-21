import { DomainError } from '../../../shared/domain-error.js';

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}
/** AU-31: the org must keep at least one owner. */
export class LastOwnerError extends DomainError {
  constructor() {
    super('CONFLICT', 'An organization must keep at least one owner', 422);
  }
}
export class EmailNotVerifiedError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'Verify your email address first', 403);
  }
}
export class MemberNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Member not found', 404);
  }
}
/** Unknown and non-member orgs are indistinguishable (multi-tenant-isolation.md §4). */
export class OrganizationNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Organization not found', 404);
  }
}
