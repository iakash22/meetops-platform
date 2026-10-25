/**
 * ARC-1 SHIM (contracts v0.4.0 directory shapes), local to apps/web until ARC-1 merges.
 *
 * Mirrors packages/contracts on `feat/contracts-v0.4-directory` (ARC-1): EmployeeDto, TeamDto, TeamMemberDto,
 * ProjectDto, their Create/Update/List request types, DIRECTORY_PATHS and the directory constants. Names match the
 * contracts exports one-to-one, so reconciling is an import swap:
 *   - types     -> `import type { ... } from '@meetops/contracts'`
 *   - constants -> `import { DIRECTORY_PATHS, ... } from '@meetops/contracts/types'`
 * then delete this file. Do not add app-only types here.
 *
 * Reconciled against ARC-1 @ 1c65a8d9 (contracts 0.4.0): every type below is identical to its contracts export
 * (checked with a type-equality test under exactOptionalPropertyTypes) and every constant has the same value.
 * Not mirrored (unused by the web app yet): the error reasons NOT_FOUND_REASONS / CONFLICT_REASONS additions
 * (PROJECT_KEY_TAKEN, TEAM_MEMBER_EXISTS) and DIRECTORY_ERROR_REASONS, the *Params types and the typebox schemas.
 */

export type Id = string;
export type IsoDateTime = string;

export const DIRECTORY_PATHS = {
  employees: '/orgs/:organizationId/employees',
  employee: '/orgs/:organizationId/employees/:employeeId',
  teams: '/orgs/:organizationId/teams',
  team: '/orgs/:organizationId/teams/:teamId',
  teamMembers: '/orgs/:organizationId/teams/:teamId/members',
  teamMember: '/orgs/:organizationId/teams/:teamId/members/:employeeId',
  projects: '/orgs/:organizationId/projects',
  project: '/orgs/:organizationId/projects/:projectId',
} as const;

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export const TEAM_MEMBER_ROLES = ['lead', 'member'] as const;
export const MAX_DIRECTORY_NAME_LENGTH = 200;
export const MAX_DIRECTORY_DESCRIPTION_LENGTH = 2000;
export const MAX_EMPLOYEE_FIELD_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 254;
/** Team / project key: uppercase letter, then 1-9 uppercase letters or digits (2-10 chars). */
export const DIRECTORY_KEY_PATTERN = '^[A-Z][A-Z0-9]{1,9}$';

/** SafeDisplayText character rules (contracts common.ts UNSAFE_DISPLAY_TEXT_CHARS, v0.3.3+). */
export const UNSAFE_DISPLAY_TEXT_CHARS =
  '\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u2028\\u2029<>"\'&\\u200B-\\u200F\\u2060\\uFEFF\\u061C' +
  '\\u202A-\\u202E\\u2066-\\u2069\\u3164\\uFE00-\\uFE0F';
/** v0.4.0 SafeMultilineText: as above, but tab/LF/CR and `<>"'&` are allowed (render as text only). */
export const UNSAFE_MULTILINE_TEXT_CHARS =
  '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u2028\\u2029' +
  '\\u200B-\\u200F\\u2060\\uFEFF\\u061C\\u202A-\\u202E\\u2066-\\u2069\\u3164\\uFE00-\\uFE0F';

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

export type CursorPageQuery = { cursor?: string; limit?: number };
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

/** `email` is present only for owner/admin callers. */
export type EmployeeDto = {
  id: Id;
  organizationId: Id;
  userId: Id | null;
  fullName: string;
  email?: string | null;
  title: string | null;
  department: string | null;
  externalId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};
export type CreateEmployeeRequest = {
  fullName: string;
  email?: string;
  title?: string;
  department?: string;
  externalId?: string;
  userId?: Id;
};
export type UpdateEmployeeRequest = {
  fullName?: string;
  email?: string | null;
  title?: string | null;
  department?: string | null;
  externalId?: string | null;
  userId?: Id | null;
};
export type ListEmployeesQuery = { cursor?: string; limit?: number; q?: string };
export type ListEmployeesResponse = CursorPage<EmployeeDto>;

export type TeamDto = {
  id: Id;
  organizationId: Id;
  name: string;
  key: string | null;
  description: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};
export type CreateTeamRequest = { name: string; key?: string; description?: string };
export type UpdateTeamRequest = { name?: string; key?: string | null; description?: string | null };
export type ListTeamsQuery = { cursor?: string; limit?: number; q?: string };
export type ListTeamsResponse = CursorPage<TeamDto>;

export type TeamMemberDto = {
  organizationId: Id;
  teamId: Id;
  employeeId: Id;
  role: TeamMemberRole;
  createdAt: IsoDateTime;
  employee: EmployeeDto;
};
export type AddTeamMemberRequest = { employeeId: Id; role?: TeamMemberRole };
export type UpdateTeamMemberRequest = { role: TeamMemberRole };
export type ListTeamMembersQuery = { cursor?: string; limit?: number; role?: TeamMemberRole };
export type ListTeamMembersResponse = CursorPage<TeamMemberDto>;

export type ProjectDto = {
  id: Id;
  organizationId: Id;
  name: string;
  key: string;
  description: string | null;
  status: ProjectStatus;
  teamId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};
export type CreateProjectRequest = { name: string; key: string; description?: string; teamId?: Id };
export type UpdateProjectRequest = {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  teamId?: Id | null;
};
export type ListProjectsQuery = {
  cursor?: string;
  limit?: number;
  status?: ProjectStatus;
  teamId?: Id;
  q?: string;
};
export type ListProjectsResponse = CursorPage<ProjectDto>;
