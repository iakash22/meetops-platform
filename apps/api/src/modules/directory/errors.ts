import { DomainError } from '../../shared/domain-error.js';
import { DirectoryConflict, InvalidCursorError } from './ports.js';

/**
 * Directory 404s (contracts v0.4.0 NOT_FOUND_REASONS). Missing, soft-deleted and other-org ids produce exactly
 * the same body, so a reason never reveals whether another tenant's id exists.
 */
export class EmployeeNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Employee not found', 404, 'EMPLOYEE_NOT_FOUND');
  }
}
export class TeamNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Team not found', 404, 'TEAM_NOT_FOUND');
  }
}
export class ProjectNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Project not found', 404, 'PROJECT_NOT_FOUND');
  }
}
/** Team member (team + employee pair) not in the team. Same reason as an unknown employee. */
export class TeamMemberNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Team member not found', 404, 'EMPLOYEE_NOT_FOUND');
  }
}
/** `userId` on an employee is not a member of the organization (contracts: same 404 as an unknown id). */
export class UserNotInOrganizationError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'User not found', 404);
  }
}
export class ProjectKeyTakenError extends DomainError {
  constructor() {
    super('CONFLICT', 'That project key is already in use', 409, 'PROJECT_KEY_TAKEN');
  }
}
export class TeamMemberExistsError extends DomainError {
  constructor() {
    super('CONFLICT', 'The employee is already a member of this team', 409, 'TEAM_MEMBER_EXISTS');
  }
}
/** Other unique constraints (team name, employee email or linked user): generic `CONFLICT` reason. */
export class DirectoryConflictError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message, 409, 'CONFLICT');
  }
}
export class InvalidCursorDomainError extends DomainError {
  constructor() {
    super('BAD_REQUEST', 'Invalid cursor', 400);
  }
}

/**
 * Translate repository errors into the contracts error envelope: unique-constraint hits become 409s with their
 * reason, an unparseable cursor a 400. Anything else is rethrown untouched.
 */
export function toDirectoryError(e: unknown): unknown {
  if (e instanceof InvalidCursorError) return new InvalidCursorDomainError();
  if (!(e instanceof DirectoryConflict)) return e;
  switch (e.kind) {
    case 'project_key':
      return new ProjectKeyTakenError();
    case 'team_member':
      return new TeamMemberExistsError();
    case 'team_name':
      return new DirectoryConflictError('A team with that name already exists');
    case 'employee_email':
      return new DirectoryConflictError('An employee with that email already exists');
    case 'employee_user':
      return new DirectoryConflictError('That user is already linked to an employee');
  }
}

/** Await a repository call, mapping its errors with {@link toDirectoryError}. */
export async function repoCall<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw toDirectoryError(e);
  }
}
