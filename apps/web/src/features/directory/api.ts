import type { HttpMethod } from '@/lib/api/client';
import {
  DIRECTORY_PATHS,
  type AddTeamMemberRequest,
  type CreateEmployeeRequest,
  type CreateProjectRequest,
  type CreateTeamRequest,
  type EmployeeDto,
  type Id,
  type ListEmployeesQuery,
  type ListEmployeesResponse,
  type ListProjectsQuery,
  type ListProjectsResponse,
  type ListTeamMembersQuery,
  type ListTeamMembersResponse,
  type ListTeamsQuery,
  type ListTeamsResponse,
  type ProjectDto,
  type TeamDto,
  type TeamMemberDto,
  type UpdateEmployeeRequest,
  type UpdateProjectRequest,
  type UpdateTeamMemberRequest,
  type UpdateTeamRequest,
} from './contracts-shim';

/** Directory endpoints (contracts v0.4 DIRECTORY_PATHS). Every call is scoped to one organization. */
export type DirectoryApi = {
  employees: {
    list: (orgId: Id, query?: ListEmployeesQuery) => Promise<ListEmployeesResponse>;
    get: (orgId: Id, employeeId: Id) => Promise<EmployeeDto>;
    create: (orgId: Id, body: CreateEmployeeRequest) => Promise<EmployeeDto>;
    update: (orgId: Id, employeeId: Id, body: UpdateEmployeeRequest) => Promise<EmployeeDto>;
    remove: (orgId: Id, employeeId: Id) => Promise<void>;
  };
  teams: {
    list: (orgId: Id, query?: ListTeamsQuery) => Promise<ListTeamsResponse>;
    get: (orgId: Id, teamId: Id) => Promise<TeamDto>;
    create: (orgId: Id, body: CreateTeamRequest) => Promise<TeamDto>;
    update: (orgId: Id, teamId: Id, body: UpdateTeamRequest) => Promise<TeamDto>;
    remove: (orgId: Id, teamId: Id) => Promise<void>;
  };
  teamMembers: {
    list: (orgId: Id, teamId: Id, query?: ListTeamMembersQuery) => Promise<ListTeamMembersResponse>;
    add: (orgId: Id, teamId: Id, body: AddTeamMemberRequest) => Promise<TeamMemberDto>;
    update: (
      orgId: Id,
      teamId: Id,
      employeeId: Id,
      body: UpdateTeamMemberRequest,
    ) => Promise<TeamMemberDto>;
    remove: (orgId: Id, teamId: Id, employeeId: Id) => Promise<void>;
  };
  projects: {
    list: (orgId: Id, query?: ListProjectsQuery) => Promise<ListProjectsResponse>;
    get: (orgId: Id, projectId: Id) => Promise<ProjectDto>;
    create: (orgId: Id, body: CreateProjectRequest) => Promise<ProjectDto>;
    update: (orgId: Id, projectId: Id, body: UpdateProjectRequest) => Promise<ProjectDto>;
    remove: (orgId: Id, projectId: Id) => Promise<void>;
  };
};

type PathParams = Partial<Record<'organizationId' | 'employeeId' | 'teamId' | 'projectId', string>>;

/** Fill `:param` placeholders; every value is URI-encoded and a missing one is an error. */
export function directoryPath(template: string, params: PathParams): string {
  return template.replace(/:(\w+)/g, (_, name: string) => {
    const value = params[name as keyof PathParams];
    if (!value) throw new Error(`Missing path param ${name}`);
    return encodeURIComponent(value);
  });
}

/** Query string from defined, non-empty values (`?a=1&b=2`), or '' when there are none. */
export function toQueryString(query: object | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
    if (typeof v === 'string' ? v === '' : typeof v !== 'number' && typeof v !== 'boolean')
      continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

type Request = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

/** HTTP implementation over ApiClient.request (cookie session, CSRF on writes, 401 handling). */
export function createHttpDirectoryApi(request: Request): DirectoryApi {
  const P = DIRECTORY_PATHS;
  return {
    employees: {
      list: (organizationId, q) =>
        request('GET', directoryPath(P.employees, { organizationId }) + toQueryString(q)),
      get: (organizationId, employeeId) =>
        request('GET', directoryPath(P.employee, { organizationId, employeeId })),
      create: (organizationId, body) =>
        request('POST', directoryPath(P.employees, { organizationId }), body),
      update: (organizationId, employeeId, body) =>
        request('PATCH', directoryPath(P.employee, { organizationId, employeeId }), body),
      remove: (organizationId, employeeId) =>
        request('DELETE', directoryPath(P.employee, { organizationId, employeeId })),
    },
    teams: {
      list: (organizationId, q) =>
        request('GET', directoryPath(P.teams, { organizationId }) + toQueryString(q)),
      get: (organizationId, teamId) =>
        request('GET', directoryPath(P.team, { organizationId, teamId })),
      create: (organizationId, body) =>
        request('POST', directoryPath(P.teams, { organizationId }), body),
      update: (organizationId, teamId, body) =>
        request('PATCH', directoryPath(P.team, { organizationId, teamId }), body),
      remove: (organizationId, teamId) =>
        request('DELETE', directoryPath(P.team, { organizationId, teamId })),
    },
    teamMembers: {
      list: (organizationId, teamId, q) =>
        request('GET', directoryPath(P.teamMembers, { organizationId, teamId }) + toQueryString(q)),
      add: (organizationId, teamId, body) =>
        request('POST', directoryPath(P.teamMembers, { organizationId, teamId }), body),
      update: (organizationId, teamId, employeeId, body) =>
        request('PATCH', directoryPath(P.teamMember, { organizationId, teamId, employeeId }), body),
      remove: (organizationId, teamId, employeeId) =>
        request('DELETE', directoryPath(P.teamMember, { organizationId, teamId, employeeId })),
    },
    projects: {
      list: (organizationId, q) =>
        request('GET', directoryPath(P.projects, { organizationId }) + toQueryString(q)),
      get: (organizationId, projectId) =>
        request('GET', directoryPath(P.project, { organizationId, projectId })),
      create: (organizationId, body) =>
        request('POST', directoryPath(P.projects, { organizationId }), body),
      update: (organizationId, projectId, body) =>
        request('PATCH', directoryPath(P.project, { organizationId, projectId }), body),
      remove: (organizationId, projectId) =>
        request('DELETE', directoryPath(P.project, { organizationId, projectId })),
    },
  };
}
