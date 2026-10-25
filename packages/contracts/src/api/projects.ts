import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, SafeDisplayText } from '../common.js';
import { MAX_DIRECTORY_NAME_LENGTH, PROJECT_STATUSES } from '../constants.js';
import { CursorPage, CursorPageQuery } from './pagination.js';
import { DirectoryDescription, DirectoryKey } from './teams.js';

export { PROJECT_STATUSES } from '../constants.js';

const strict = { additionalProperties: false } as const;

/** Project name: SafeDisplayText, 1-200, trimmed. */
export const ProjectName = SafeDisplayText({ maxLength: MAX_DIRECTORY_NAME_LENGTH, trimmed: true });
/** Project lifecycle state (Prisma `ProjectStatus`). */
export const ProjectStatus = Type.Union(PROJECT_STATUSES.map((s) => Type.Literal(s)));
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * v0.4.0: a project (Prisma `Project`, table `projects`) as returned by the directory routes. Soft-deleted projects are
 * never returned. `key` is unique per organization and immutable after create. `teamId` is the owning team, or null.
 * Supersedes the looser domain `Project` schema for these routes.
 */
export const ProjectDto = Type.Object(
  {
    id: Id,
    organizationId: Id,
    name: ProjectName,
    key: DirectoryKey,
    description: Type.Union([DirectoryDescription, Type.Null()]),
    status: ProjectStatus,
    teamId: Type.Union([Id, Type.Null()]),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type ProjectDto = Static<typeof ProjectDto>;

/** Path params of the projects collection routes (`DIRECTORY_PATHS.projects`). */
export const ProjectsParams = Type.Object({ organizationId: Id }, strict);
export type ProjectsParams = Static<typeof ProjectsParams>;
/** Path params of the single-project routes (`DIRECTORY_PATHS.project`). */
export const ProjectParams = Type.Object({ organizationId: Id, projectId: Id }, strict);
export type ProjectParams = Static<typeof ProjectParams>;

/**
 * POST /orgs/:organizationId/projects (201 ProjectDto). A `key` already used in the organization (including by a
 * soft-deleted project) is a 409 `PROJECT_KEY_TAKEN`. An unknown `teamId` is a 404 `TEAM_NOT_FOUND`. New projects are
 * `active`.
 */
export const CreateProjectRequest = Type.Object(
  {
    name: ProjectName,
    key: DirectoryKey,
    description: Type.Optional(DirectoryDescription),
    teamId: Type.Optional(Id),
  },
  strict,
);
export type CreateProjectRequest = Static<typeof CreateProjectRequest>;

/**
 * PATCH /orgs/:organizationId/projects/:projectId (200 ProjectDto). At least one field; `null` clears `description`
 * or `teamId`. `key` cannot be changed (it is rejected as an unknown property).
 */
export const UpdateProjectRequest = Type.Object(
  {
    name: Type.Optional(ProjectName),
    description: Type.Optional(Type.Union([DirectoryDescription, Type.Null()])),
    status: Type.Optional(ProjectStatus),
    teamId: Type.Optional(Type.Union([Id, Type.Null()])),
  },
  { ...strict, minProperties: 1 },
);
export type UpdateProjectRequest = Static<typeof UpdateProjectRequest>;

/** GET /orgs/:organizationId/projects query: cursor page plus optional `status`, `teamId` and name/key search `q`. */
export const ListProjectsQuery = Type.Object(
  {
    ...CursorPageQuery.properties,
    status: Type.Optional(ProjectStatus),
    teamId: Type.Optional(Id),
    q: Type.Optional(SafeDisplayText({ maxLength: MAX_DIRECTORY_NAME_LENGTH })),
  },
  strict,
);
export type ListProjectsQuery = Static<typeof ListProjectsQuery>;

/** GET /orgs/:organizationId/projects: cursor page of ProjectDto. */
export const ListProjectsResponse = Type.Object(CursorPage(ProjectDto).properties, strict);
export type ListProjectsResponse = Static<typeof ListProjectsResponse>;
