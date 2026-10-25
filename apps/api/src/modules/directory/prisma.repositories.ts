import {
  createEmployeeRepository,
  createProjectRepository,
  createTeamMemberRepository,
  createTeamRepository,
  isDirectoryError,
  type DirectoryErrorReason,
} from '@meetops/database';
import type { DatabaseClient } from '../../shared/prisma/context.js';
import { EmployeeNotFoundError, TeamNotFoundError, UserNotInOrganizationError } from './errors.js';
import {
  DirectoryConflict,
  InvalidCursorError,
  type ConflictKind,
  type DirectoryRepositories,
  type EmployeeCreate,
  type ProjectCreate,
  type TeamCreate,
} from './ports.js';

const CONFLICTS: Partial<Record<DirectoryErrorReason, ConflictKind>> = {
  EMPLOYEE_EMAIL_TAKEN: 'employee_email',
  EMPLOYEE_USER_TAKEN: 'employee_user',
  TEAM_NAME_TAKEN: 'team_name',
  TEAM_MEMBER_EXISTS: 'team_member',
  PROJECT_KEY_TAKEN: 'project_key',
};

/** DB-2's DirectoryError -> the port's errors, so services and routes stay storage-agnostic. */
function translate(e: unknown): unknown {
  if (!isDirectoryError(e)) return e;
  const conflict = CONFLICTS[e.reason];
  if (conflict) return new DirectoryConflict(conflict);
  switch (e.reason) {
    case 'INVALID_CURSOR':
      return new InvalidCursorError();
    case 'TEAM_NOT_FOUND':
      return new TeamNotFoundError();
    case 'EMPLOYEE_NOT_FOUND':
      return new EmployeeNotFoundError();
    case 'USER_NOT_MEMBER':
      return new UserNotInOrganizationError();
    default:
      return e;
  }
}
async function call<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw translate(e);
  }
}

/** Drop undefined and null keys: DB-2 create inputs take optional strings, not nulls. */
function present<T extends object>(input: T) {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined && v !== null),
  ) as { [K in keyof T]?: Exclude<T[K], null | undefined> };
}
/** Drop undefined keys only (a null in a patch clears the column). */
function defined<T extends object>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * DirectoryRepositories backed by the DB-2 Prisma repositories (`@meetops/database`). Every call runs
 * inside runWithOrganizationContext, so forced RLS scopes it to the caller's organization.
 */
export function createPrismaDirectory(client: DatabaseClient): DirectoryRepositories {
  const options = { client };
  const employees = createEmployeeRepository(options);
  const teams = createTeamRepository(options);
  const members = createTeamMemberRepository(options);
  const projects = createProjectRepository(options);

  return {
    employees: {
      list: (orgId, q) => call(employees.list(orgId, defined(q))),
      findById: (orgId, id) => call(employees.get(orgId, id)),
      create: (orgId, data: EmployeeCreate) =>
        call(employees.create(orgId, { ...present(data), fullName: data.fullName })),
      update: (orgId, id, patch) => call(employees.update(orgId, id, defined(patch))),
      softDelete: (orgId, id) => call(employees.softDelete(orgId, id)),
    },
    teams: {
      list: (orgId, q) => call(teams.list(orgId, defined(q))),
      findById: (orgId, id) => call(teams.get(orgId, id)),
      create: (orgId, data: TeamCreate) =>
        call(teams.create(orgId, { ...present(data), name: data.name })),
      update: (orgId, id, patch) => call(teams.update(orgId, id, defined(patch))),
      // DB-2 unlinks the team's projects in the same transaction as the soft delete.
      softDelete: (orgId, id) => call(teams.softDelete(orgId, id)),
    },
    teamMembers: {
      async list(orgId, teamId, q) {
        const page = await call(members.list(orgId, teamId, defined(q)));
        if (!page) throw new TeamNotFoundError();
        return page;
      },
      add: (orgId, teamId, employeeId, role) => call(members.add(orgId, teamId, employeeId, role)),
      updateRole: (orgId, teamId, employeeId, role) =>
        call(members.updateRole(orgId, teamId, employeeId, role)),
      remove: (orgId, teamId, employeeId) => call(members.remove(orgId, teamId, employeeId)),
    },
    projects: {
      list: (orgId, q) => call(projects.list(orgId, defined(q))),
      findById: (orgId, id) => call(projects.get(orgId, id)),
      create: (orgId, data: ProjectCreate) =>
        call(projects.create(orgId, { ...present(data), name: data.name, key: data.key })),
      update: (orgId, id, patch) => call(projects.update(orgId, id, defined(patch))),
      softDelete: (orgId, id) => call(projects.softDelete(orgId, id)),
    },
  };
}
