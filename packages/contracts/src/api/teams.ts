import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, SafeDisplayText, SafeMultilineText } from '../common.js';
import {
  DIRECTORY_KEY_PATTERN,
  MAX_DIRECTORY_DESCRIPTION_LENGTH,
  MAX_DIRECTORY_NAME_LENGTH,
  TEAM_MEMBER_ROLES,
} from '../constants.js';
import { EmployeeDto } from './employees.js';
import { CursorPage, CursorPageQuery } from './pagination.js';

export {
  TEAM_MEMBER_ROLES,
  DIRECTORY_PATHS,
  DIRECTORY_KEY_PATTERN,
  MAX_DIRECTORY_NAME_LENGTH,
  MAX_DIRECTORY_DESCRIPTION_LENGTH,
  MAX_EMPLOYEE_FIELD_LENGTH,
  MAX_EMAIL_LENGTH,
} from '../constants.js';

const strict = { additionalProperties: false } as const;

/** Team name: SafeDisplayText, 1-200, trimmed. Unique per organization (case as stored). */
export const TeamName = SafeDisplayText({ maxLength: MAX_DIRECTORY_NAME_LENGTH, trimmed: true });
/** Short team or project key (DIRECTORY_KEY_PATTERN), e.g. `OPS`. */
export const DirectoryKey = Type.String({
  pattern: DIRECTORY_KEY_PATTERN,
  minLength: 2,
  maxLength: 10,
});
/** Team or project description: SafeMultilineText, 1-2000. */
export const DirectoryDescription = SafeMultilineText({
  maxLength: MAX_DIRECTORY_DESCRIPTION_LENGTH,
});

/** A member's role in a team: `lead` or `member` (not an organization Role). */
export const TeamMemberRole = Type.Union(TEAM_MEMBER_ROLES.map((r) => Type.Literal(r)));
export type TeamMemberRole = (typeof TEAM_MEMBER_ROLES)[number];

/** v0.4.0: a team (Prisma `Team`, table `teams`). Soft-deleted teams are never returned. */
export const TeamDto = Type.Object(
  {
    id: Id,
    organizationId: Id,
    name: TeamName,
    key: Type.Union([DirectoryKey, Type.Null()]),
    description: Type.Union([DirectoryDescription, Type.Null()]),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type TeamDto = Static<typeof TeamDto>;

/** Path params of the teams collection routes (`DIRECTORY_PATHS.teams`). */
export const TeamsParams = Type.Object({ organizationId: Id }, strict);
export type TeamsParams = Static<typeof TeamsParams>;
/** Path params of the single-team and team-members collection routes (`DIRECTORY_PATHS.team`, `.teamMembers`). */
export const TeamParams = Type.Object({ organizationId: Id, teamId: Id }, strict);
export type TeamParams = Static<typeof TeamParams>;
/** Path params of the single team-member routes (`DIRECTORY_PATHS.teamMember`). */
export const TeamMemberParams = Type.Object(
  { organizationId: Id, teamId: Id, employeeId: Id },
  strict,
);
export type TeamMemberParams = Static<typeof TeamMemberParams>;

/** POST /orgs/:organizationId/teams (201 TeamDto). A duplicate name is a 409 with the generic `CONFLICT` reason. */
export const CreateTeamRequest = Type.Object(
  {
    name: TeamName,
    key: Type.Optional(DirectoryKey),
    description: Type.Optional(DirectoryDescription),
  },
  strict,
);
export type CreateTeamRequest = Static<typeof CreateTeamRequest>;

/** PATCH /orgs/:organizationId/teams/:teamId (200 TeamDto). At least one field; `null` clears `key` or `description`. */
export const UpdateTeamRequest = Type.Object(
  {
    name: Type.Optional(TeamName),
    key: Type.Optional(Type.Union([DirectoryKey, Type.Null()])),
    description: Type.Optional(Type.Union([DirectoryDescription, Type.Null()])),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateTeamRequest = Static<typeof UpdateTeamRequest>;

/** GET /orgs/:organizationId/teams query: cursor page plus an optional name search `q`. */
export const ListTeamsQuery = Type.Object(
  {
    ...CursorPageQuery.properties,
    q: Type.Optional(SafeDisplayText({ maxLength: MAX_DIRECTORY_NAME_LENGTH })),
  },
  strict,
);
export type ListTeamsQuery = Static<typeof ListTeamsQuery>;

/** GET /orgs/:organizationId/teams: cursor page of TeamDto. */
export const ListTeamsResponse = Type.Object(CursorPage(TeamDto).properties, strict);
export type ListTeamsResponse = Static<typeof ListTeamsResponse>;

/**
 * v0.4.0: an employee's membership of a team (table `team_members`, unique per team + employee). `employee` is the
 * member's EmployeeDto, with the same email-visibility rule.
 */
export const TeamMemberDto = Type.Object(
  {
    organizationId: Id,
    teamId: Id,
    employeeId: Id,
    role: TeamMemberRole,
    createdAt: IsoDateTime,
    employee: EmployeeDto,
  },
  strict,
);
export type TeamMemberDto = Static<typeof TeamMemberDto>;

/**
 * POST /orgs/:organizationId/teams/:teamId/members (201 TeamMemberDto). `role` defaults to `member`. An employee who is
 * already in the team is a 409 `TEAM_MEMBER_EXISTS`; an unknown team or employee is a 404 `TEAM_NOT_FOUND` or
 * `EMPLOYEE_NOT_FOUND`.
 */
export const AddTeamMemberRequest = Type.Object(
  { employeeId: Id, role: Type.Optional(TeamMemberRole) },
  strict,
);
export type AddTeamMemberRequest = Static<typeof AddTeamMemberRequest>;

/** PATCH /orgs/:organizationId/teams/:teamId/members/:employeeId (200 TeamMemberDto). */
export const UpdateTeamMemberRequest = Type.Object({ role: TeamMemberRole }, strict);
export type UpdateTeamMemberRequest = Static<typeof UpdateTeamMemberRequest>;

/** GET /orgs/:organizationId/teams/:teamId/members query: cursor page plus an optional `role` filter. */
export const ListTeamMembersQuery = Type.Object(
  { ...CursorPageQuery.properties, role: Type.Optional(TeamMemberRole) },
  strict,
);
export type ListTeamMembersQuery = Static<typeof ListTeamMembersQuery>;

/** GET /orgs/:organizationId/teams/:teamId/members: cursor page of TeamMemberDto. */
export const ListTeamMembersResponse = Type.Object(CursorPage(TeamMemberDto).properties, strict);
export type ListTeamMembersResponse = Static<typeof ListTeamMembersResponse>;
