import { DomainError } from '../../../shared/domain-error.js';

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}
export class NotAMemberError extends DomainError {
  constructor() {
    super('NOT_A_MEMBER', 'You are not a member of this organization', 403);
  }
}
export class OrganizationNotFoundError extends DomainError {
  constructor() {
    super('ORGANIZATION_NOT_FOUND', 'Organization not found', 404);
  }
}
