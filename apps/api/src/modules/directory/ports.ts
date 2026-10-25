/**
 * Directory persistence ports (BE-3). Implemented in memory (dev/test) and by the DB-2 Prisma repositories
 * (`@meetops/database` directory repos) through an adapter.
 *
 * Tenancy contract for every implementation:
 * - every call takes the organization id from the TenantContext (never from request input) and only touches
 *   rows of that organization (Prisma: inside `runWithOrganizationContext`, so RLS applies too);
 * - a soft-deleted row, a missing row and another organization's row are all reported as `null`, so the routes
 *   return the same 404 for all three;
 * - unique-constraint violations are reported as {@link DirectoryConflict}, never as a raw driver error.
 */
export type ProjectStatus = 'active' | 'archived';
export type TeamMemberRole = 'lead' | 'member';

export interface EmployeeRecord {
  id: string;
  organizationId: string;
  userId: string | null;
  fullName: string;
  email: string | null;
  title: string | null;
  department: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamRecord {
  id: string;
  organizationId: string;
  name: string;
  key: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMemberRecord {
  organizationId: string;
  teamId: string;
  employeeId: string;
  role: TeamMemberRole;
  createdAt: Date;
  employee: EmployeeRecord;
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  teamId: string | null;
  name: string;
  key: string;
  description: string | null;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Cursor page request. `cursor` is opaque; an invalid one throws {@link InvalidCursorError}. */
export interface PageRequest {
  cursor?: string | undefined;
  limit: number;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Which unique constraint a write hit. */
export type ConflictKind =
  'employee_email' | 'employee_user' | 'team_name' | 'team_member' | 'project_key';

export class DirectoryConflict extends Error {
  constructor(public readonly kind: ConflictKind) {
    super(`Directory unique constraint: ${kind}`);
    this.name = 'DirectoryConflict';
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

export interface EmployeeCreate {
  fullName: string;
  email?: string | null | undefined;
  title?: string | null | undefined;
  department?: string | null | undefined;
  externalId?: string | null | undefined;
  userId?: string | null | undefined;
}
export type EmployeePatch = Partial<EmployeeCreate>;

export interface EmployeeRepository {
  list(orgId: string, q: PageRequest & { q?: string | undefined }): Promise<Page<EmployeeRecord>>;
  findById(orgId: string, id: string): Promise<EmployeeRecord | null>;
  /** Throws DirectoryConflict('employee_email' | 'employee_user'). */
  create(orgId: string, data: EmployeeCreate): Promise<EmployeeRecord>;
  /** Null when the employee is missing, deleted or in another org. Throws DirectoryConflict. */
  update(orgId: string, id: string, patch: EmployeePatch): Promise<EmployeeRecord | null>;
  /** Soft delete; also removes the employee's team memberships. False when not found. */
  softDelete(orgId: string, id: string): Promise<boolean>;
}

export interface TeamCreate {
  name: string;
  key?: string | null | undefined;
  description?: string | null | undefined;
}
export type TeamPatch = Partial<TeamCreate>;

export interface TeamRepository {
  list(orgId: string, q: PageRequest & { q?: string | undefined }): Promise<Page<TeamRecord>>;
  findById(orgId: string, id: string): Promise<TeamRecord | null>;
  /** Throws DirectoryConflict('team_name'). */
  create(orgId: string, data: TeamCreate): Promise<TeamRecord>;
  update(orgId: string, id: string, patch: TeamPatch): Promise<TeamRecord | null>;
  /** Soft delete; also removes its members and clears `teamId` on its projects. False when not found. */
  softDelete(orgId: string, id: string): Promise<boolean>;
}

export interface TeamMemberRepository {
  /** Members whose employee is not soft-deleted, of a team the caller already resolved. */
  list(
    orgId: string,
    teamId: string,
    q: PageRequest & { role?: TeamMemberRole | undefined },
  ): Promise<Page<TeamMemberRecord>>;
  /** Throws DirectoryConflict('team_member'). */
  add(
    orgId: string,
    teamId: string,
    employeeId: string,
    role: TeamMemberRole,
  ): Promise<TeamMemberRecord>;
  updateRole(
    orgId: string,
    teamId: string,
    employeeId: string,
    role: TeamMemberRole,
  ): Promise<TeamMemberRecord | null>;
  remove(orgId: string, teamId: string, employeeId: string): Promise<boolean>;
}

export interface ProjectCreate {
  name: string;
  key: string;
  description?: string | null | undefined;
  teamId?: string | null | undefined;
}
export interface ProjectPatch {
  name?: string | undefined;
  description?: string | null | undefined;
  status?: ProjectStatus | undefined;
  teamId?: string | null | undefined;
}

export interface ProjectRepository {
  list(
    orgId: string,
    q: PageRequest & {
      q?: string | undefined;
      status?: ProjectStatus | undefined;
      teamId?: string | undefined;
    },
  ): Promise<Page<ProjectRecord>>;
  findById(orgId: string, id: string): Promise<ProjectRecord | null>;
  /** Throws DirectoryConflict('project_key'), also for a key held by a soft-deleted project. */
  create(orgId: string, data: ProjectCreate): Promise<ProjectRecord>;
  update(orgId: string, id: string, patch: ProjectPatch): Promise<ProjectRecord | null>;
  softDelete(orgId: string, id: string): Promise<boolean>;
}

export interface DirectoryRepositories {
  employees: EmployeeRepository;
  teams: TeamRepository;
  teamMembers: TeamMemberRepository;
  projects: ProjectRepository;
}
