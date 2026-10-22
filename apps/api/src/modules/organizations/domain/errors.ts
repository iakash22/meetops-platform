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
/**
 * The address already belongs to an active member (invite), or the accepting user already has an active
 * membership (accept, DB `already_member`). Membership is never changed by an invitation, so an invite can
 * not demote an owner or bypass the last-owner rule. Only inviters (who can list members anyway) or the
 * holder of a valid invitation token for their own address can see this, so it reveals nothing new.
 */
export class AlreadyMemberError extends DomainError {
  constructor() {
    super('CONFLICT', 'This person is already a member of the organization', 409);
  }
}
