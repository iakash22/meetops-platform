import { describe, it, expect, expectTypeOf } from 'vitest';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as C from '../src/index.js';
import {
  AddTeamMemberRequest,
  API_ERROR_REASONS,
  ApiErrorEnvelope,
  ApiErrorReason,
  CONFLICT_REASONS,
  CreateEmployeeRequest,
  CreateProjectRequest,
  CreateTeamRequest,
  DIRECTORY_ERROR_REASONS,
  DIRECTORY_PATHS,
  EmployeeDto,
  EmployeeParams,
  ListEmployeesQuery,
  ListEmployeesResponse,
  ListProjectsQuery,
  ListProjectsResponse,
  ListTeamMembersQuery,
  ListTeamMembersResponse,
  ListTeamsResponse,
  MAX_PAGE_LIMIT,
  NOT_FOUND_HTTP_STATUS,
  NOT_FOUND_REASONS,
  NotFoundReason,
  ProjectDto,
  ProjectParams,
  TeamDto,
  TeamMemberDto,
  TeamMemberParams,
  TeamParams,
  UpdateEmployeeRequest,
  UpdateProjectRequest,
  UpdateTeamMemberRequest,
  UpdateTeamRequest,
} from '../src/index.js';
import * as Light from '../src/types.js';
import type * as T from '../src/types.js';
import pkg from '../package.json' with { type: 'json' };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = id(1);
const at = '2026-10-25T09:00:00.000Z';
const ok = (s: TSchema, v: unknown) => expect(Value.Check(s, v)).toBe(true);
const bad = (s: TSchema, v: unknown) => expect(Value.Check(s, v)).toBe(false);

/** Name values the shared unsafe-char rules (common.ts SafeDisplayText) must reject. */
const UNSAFE_NAMES = [
  '',
  ' ',
  ' Alice',
  'Alice ',
  'Al\u0000ice',
  'Al\nice',
  'Al\tice',
  'Al\u007Fice',
  'Al\u0085ice',
  '<b>Alice</b>',
  'Al"ice',
  'Al&ice',
  "Al'ice",
  'Al\u202Eice',
  'Al\u200Bice',
  'Al\uFEFFice',
  'Al\u2028ice',
  'Al\uDB40\uDC41ice',
];

const employee = {
  id: id(10),
  organizationId: ORG,
  userId: null,
  fullName: 'Asha Rao',
  email: 'asha@example.com',
  title: 'Engineer',
  department: null,
  externalId: null,
  createdAt: at,
  updatedAt: at,
};
const team = {
  id: id(20),
  organizationId: ORG,
  name: 'Platform',
  key: 'PLAT',
  description: null,
  createdAt: at,
  updatedAt: at,
};
const member = {
  organizationId: ORG,
  teamId: id(20),
  employeeId: id(10),
  role: 'lead',
  createdAt: at,
  employee,
};
const project = {
  id: id(30),
  organizationId: ORG,
  name: 'MeetOps',
  key: 'MOPS',
  description: 'Line one\nLine two & more',
  status: 'active',
  teamId: id(20),
  createdAt: at,
  updatedAt: at,
};

describe('v0.4.0 package version', () => {
  it('is 0.4.0', () => expect(pkg.version).toBe('0.4.0'));
});

describe('v0.4.0 directory resources', () => {
  it.each([
    ['EmployeeDto', EmployeeDto, employee],
    ['TeamDto', TeamDto, team],
    ['TeamMemberDto', TeamMemberDto, member],
    ['ProjectDto', ProjectDto, project],
  ] as const)('%s accepts a valid value and rejects extra properties', (_n, schema, value) => {
    ok(schema, value);
    bad(schema, { ...value, deletedAt: at });
    bad(schema, { ...value, passwordHash: 'x' });
  });
  it('ids are UUIDs', () => {
    bad(EmployeeDto, { ...employee, id: 'emp-1' });
    bad(EmployeeDto, { ...employee, organizationId: '1' });
    bad(TeamDto, { ...team, id: '00000000-0000-0000-0000-000000000000' });
    bad(ProjectDto, { ...project, teamId: 'team-1' });
    bad(TeamMemberDto, { ...member, employeeId: 42 });
  });
  it('employee email is optional (RBAC: omitted for member/viewer) and may be null', () => {
    const noEmail: Record<string, unknown> = { ...employee };
    delete noEmail.email;
    ok(EmployeeDto, noEmail);
    ok(EmployeeDto, { ...employee, email: null });
    bad(EmployeeDto, { ...employee, email: 'not-an-email' });
    bad(EmployeeDto, { ...employee, email: `${'a'.repeat(250)}@x.io` });
  });
  it('project status and team member role are closed enums', () => {
    ok(ProjectDto, { ...project, status: 'archived' });
    bad(ProjectDto, { ...project, status: 'deleted' });
    bad(TeamMemberDto, { ...member, role: 'owner' });
  });
  it('the list responses are strict cursor pages capped at MAX_PAGE_LIMIT', () => {
    ok(ListEmployeesResponse, { items: [employee], nextCursor: null });
    ok(ListTeamsResponse, { items: [team], nextCursor: 'abc' });
    ok(ListTeamMembersResponse, { items: [member], nextCursor: null });
    ok(ListProjectsResponse, { items: [project], nextCursor: null });
    bad(ListProjectsResponse, { items: [project] });
    bad(ListProjectsResponse, { items: [project], nextCursor: null, total: 1 });
    bad(ListEmployeesResponse, {
      items: Array.from({ length: MAX_PAGE_LIMIT + 1 }, () => employee),
      nextCursor: null,
    });
  });
});

describe('v0.4.0 directory requests', () => {
  it('create requests accept minimal and full payloads', () => {
    ok(CreateEmployeeRequest, { fullName: 'Asha Rao' });
    ok(CreateEmployeeRequest, {
      fullName: 'Asha Rao',
      email: 'asha@example.com',
      title: 'Engineer',
      department: 'R and D',
      externalId: 'HR-42',
      userId: id(2),
    });
    ok(CreateTeamRequest, { name: 'Platform' });
    ok(CreateTeamRequest, {
      name: 'Platform',
      key: 'PLAT',
      description: "Owns the API.\nIt's on-call & reviews.",
    });
    ok(CreateProjectRequest, { name: 'MeetOps', key: 'MOPS' });
    ok(CreateProjectRequest, { name: 'MeetOps', key: 'MOPS', description: 'x', teamId: id(20) });
    ok(AddTeamMemberRequest, { employeeId: id(10) });
    ok(AddTeamMemberRequest, { employeeId: id(10), role: 'member' });
  });
  it('create requests reject missing required fields, unknown properties and server-owned fields', () => {
    bad(CreateEmployeeRequest, {});
    bad(CreateEmployeeRequest, { fullName: 'Asha', organizationId: ORG });
    bad(CreateEmployeeRequest, { fullName: 'Asha', id: id(9) });
    bad(CreateTeamRequest, { key: 'PLAT' });
    bad(CreateTeamRequest, { name: 'Platform', organizationId: ORG });
    bad(CreateProjectRequest, { name: 'MeetOps' });
    bad(CreateProjectRequest, { name: 'MeetOps', key: 'MOPS', status: 'archived' });
    bad(AddTeamMemberRequest, { employeeId: id(10), teamId: id(20) });
    bad(AddTeamMemberRequest, { employeeId: 'asha' });
    bad(AddTeamMemberRequest, { employeeId: id(10), role: 'admin' });
  });
  it('names are capped at 200 characters', () => {
    ok(CreateEmployeeRequest, { fullName: 'a'.repeat(200) });
    bad(CreateEmployeeRequest, { fullName: 'a'.repeat(201) });
    ok(CreateTeamRequest, { name: 'a'.repeat(200) });
    bad(CreateTeamRequest, { name: 'a'.repeat(201) });
    ok(CreateProjectRequest, { name: 'a'.repeat(200), key: 'AB' });
    bad(CreateProjectRequest, { name: 'a'.repeat(201), key: 'AB' });
    bad(CreateEmployeeRequest, { fullName: 'Asha', title: 't'.repeat(201) });
  });
  it.each(UNSAFE_NAMES)(
    'names reject unsafe or untrimmed value %j (shared SafeDisplayText rules)',
    (name) => {
      bad(CreateEmployeeRequest, { fullName: name });
      bad(CreateTeamRequest, { name });
      bad(CreateProjectRequest, { name, key: 'AB' });
      bad(UpdateEmployeeRequest, { department: name });
    },
  );
  it('names accept non-ASCII letters', () => {
    ok(CreateEmployeeRequest, { fullName: 'Ānanya Ōtsuka-Müller' });
    ok(CreateTeamRequest, { name: 'टीम प्लेटफ़ॉर्म' });
  });
  it('descriptions allow newlines and prose punctuation but no control, bidi or tag characters, max 2000', () => {
    ok(CreateTeamRequest, { name: 'T', description: 'a\r\nb\tc <d> "e" & f' });
    ok(CreateTeamRequest, { name: 'T', description: 'd'.repeat(2000) });
    bad(CreateTeamRequest, { name: 'T', description: 'd'.repeat(2001) });
    bad(CreateTeamRequest, { name: 'T', description: '' });
    for (const c of [
      '\u0000',
      '\u0007',
      '\u001B',
      '\u007F',
      '\u0085',
      '\u202E',
      '\u2066',
      '\u200B',
      '\uFEFF',
      '\u2028',
      '\uDB40\uDC41',
    ]) {
      bad(CreateTeamRequest, { name: 'T', description: `a${c}b` });
      bad(CreateProjectRequest, { name: 'P', key: 'AB', description: `a${c}b` });
    }
  });
  it('keys are 2-10 uppercase letters/digits starting with a letter', () => {
    for (const key of ['AB', 'OPS', 'WEB2', 'ABCDEFGHIJ'])
      ok(CreateProjectRequest, { name: 'P', key });
    for (const key of ['', 'A', 'ops', '2OPS', 'OP-S', 'ABCDEFGHIJK', 'OPS ', 'ÖPS'])
      bad(CreateProjectRequest, { name: 'P', key });
    bad(CreateTeamRequest, { name: 'T', key: 'plat' });
  });
  it('update requests need at least one field, allow null to clear, and keep project key immutable', () => {
    bad(UpdateEmployeeRequest, {});
    ok(UpdateEmployeeRequest, { title: null, userId: null });
    bad(UpdateEmployeeRequest, { fullName: null });
    bad(UpdateEmployeeRequest, { fullName: 'A', organizationId: ORG });
    bad(UpdateTeamRequest, {});
    ok(UpdateTeamRequest, { key: null, description: null });
    bad(UpdateTeamRequest, { name: null });
    bad(UpdateProjectRequest, {});
    ok(UpdateProjectRequest, { status: 'archived', teamId: null });
    bad(UpdateProjectRequest, { key: 'NEW' });
    bad(UpdateProjectRequest, { name: null });
    ok(UpdateTeamMemberRequest, { role: 'member' });
    bad(UpdateTeamMemberRequest, {});
    bad(UpdateTeamMemberRequest, { role: 'lead', employeeId: id(1) });
  });
  it('list queries use cursor pagination with the shared limits and strict filters', () => {
    ok(ListEmployeesQuery, {});
    ok(ListEmployeesQuery, { cursor: 'abc', limit: 50, q: 'asha' });
    bad(ListEmployeesQuery, { limit: 0 });
    bad(ListEmployeesQuery, { limit: MAX_PAGE_LIMIT + 1 });
    bad(ListEmployeesQuery, { q: '' });
    bad(ListEmployeesQuery, { q: 'a<script>' });
    bad(ListEmployeesQuery, { orgId: ORG });
    ok(ListProjectsQuery, { status: 'active', teamId: id(20) });
    bad(ListProjectsQuery, { status: 'gone' });
    bad(ListProjectsQuery, { teamId: 'x' });
    ok(ListTeamMembersQuery, { role: 'lead' });
    bad(ListTeamMembersQuery, { role: 'owner' });
  });
  it('path params are UUIDs and strict', () => {
    ok(EmployeeParams, { organizationId: ORG, employeeId: id(10) });
    bad(EmployeeParams, { organizationId: ORG, employeeId: '../x' });
    ok(TeamParams, { organizationId: ORG, teamId: id(20) });
    ok(TeamMemberParams, { organizationId: ORG, teamId: id(20), employeeId: id(10) });
    bad(TeamMemberParams, { organizationId: ORG, teamId: id(20) });
    ok(ProjectParams, { organizationId: ORG, projectId: id(30) });
    bad(ProjectParams, { organizationId: 'acme', projectId: id(30) });
    bad(ProjectParams, { organizationId: ORG, projectId: id(30), extra: '1' });
  });
});

describe('v0.4.0 directory routes', () => {
  it('are all under /orgs/:organizationId', () => {
    for (const path of Object.values(DIRECTORY_PATHS))
      expect(path.startsWith('/orgs/:organizationId/')).toBe(true);
    expect(DIRECTORY_PATHS).toEqual({
      employees: '/orgs/:organizationId/employees',
      employee: '/orgs/:organizationId/employees/:employeeId',
      teams: '/orgs/:organizationId/teams',
      team: '/orgs/:organizationId/teams/:teamId',
      teamMembers: '/orgs/:organizationId/teams/:teamId/members',
      teamMember: '/orgs/:organizationId/teams/:teamId/members/:employeeId',
      projects: '/orgs/:organizationId/projects',
      project: '/orgs/:organizationId/projects/:projectId',
    });
  });
  it('the path params schemas name exactly the route placeholders', () => {
    const placeholders = (p: string) => [...p.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
    expect(Object.keys(EmployeeParams.properties).sort()).toEqual(
      placeholders(DIRECTORY_PATHS.employee),
    );
    expect(Object.keys(TeamParams.properties).sort()).toEqual(
      placeholders(DIRECTORY_PATHS.teamMembers),
    );
    expect(Object.keys(TeamMemberParams.properties).sort()).toEqual(
      placeholders(DIRECTORY_PATHS.teamMember),
    );
    expect(Object.keys(ProjectParams.properties).sort()).toEqual(
      placeholders(DIRECTORY_PATHS.project),
    );
  });
  it('are exposed by the light /types entry', () => {
    expect(Light.DIRECTORY_PATHS).toBe(DIRECTORY_PATHS);
    expect(Light.PROJECT_STATUSES).toEqual(['active', 'archived']);
    expect(Light.TEAM_MEMBER_ROLES).toEqual(['lead', 'member']);
  });
});

describe('v0.4.0 directory error codes', () => {
  it('names the five directory errors', () => {
    expect([...DIRECTORY_ERROR_REASONS]).toEqual([
      'EMPLOYEE_NOT_FOUND',
      'TEAM_NOT_FOUND',
      'PROJECT_NOT_FOUND',
      'PROJECT_KEY_TAKEN',
      'TEAM_MEMBER_EXISTS',
    ]);
    expect([...NOT_FOUND_REASONS]).toEqual([
      'EMPLOYEE_NOT_FOUND',
      'TEAM_NOT_FOUND',
      'PROJECT_NOT_FOUND',
    ]);
    expect(CONFLICT_REASONS).toContain('PROJECT_KEY_TAKEN');
    expect(CONFLICT_REASONS).toContain('TEAM_MEMBER_EXISTS');
    for (const r of DIRECTORY_ERROR_REASONS) expect(API_ERROR_REASONS).toContain(r);
    expect(new Set(API_ERROR_REASONS).size).toBe(API_ERROR_REASONS.length);
    expect(NOT_FOUND_HTTP_STATUS).toBe(404);
    expect(Light.NOT_FOUND_REASONS).toBe(NOT_FOUND_REASONS);
  });
  it('envelopes carry them as reason, next to the generic NOT_FOUND / CONFLICT code', () => {
    const env = (code: string, reason: string) => ({
      error: { code, message: 'Not found', requestId: 'r1', reason },
    });
    ok(ApiErrorEnvelope, env('NOT_FOUND', 'PROJECT_NOT_FOUND'));
    ok(ApiErrorEnvelope, env('CONFLICT', 'PROJECT_KEY_TAKEN'));
    ok(ApiErrorEnvelope, env('CONFLICT', 'TEAM_MEMBER_EXISTS'));
    bad(ApiErrorEnvelope, env('NOT_FOUND', 'project_not_found'));
    bad(ApiErrorEnvelope, env('NOT_FOUND', 'ORG_NOT_FOUND'));
    // The error codes themselves are unchanged: no per-entity codes that would bypass the NOT_FOUND tenancy rule.
    expect(C.API_ERROR_CODES).not.toContain('PROJECT_NOT_FOUND');
    for (const r of NOT_FOUND_REASONS) {
      expect(Value.Check(NotFoundReason, r)).toBe(true);
      expect(Value.Check(ApiErrorReason, r)).toBe(true);
    }
  });
  it('types', () => {
    expectTypeOf<T.NotFoundErrorEnvelope['error']['code']>().toEqualTypeOf<'NOT_FOUND'>();
    expectTypeOf<T.NotFoundErrorEnvelope['error']['reason']>().toEqualTypeOf<T.NotFoundReason>();
    expectTypeOf<T.NotFoundReason>().toEqualTypeOf<
      'EMPLOYEE_NOT_FOUND' | 'TEAM_NOT_FOUND' | 'PROJECT_NOT_FOUND'
    >();
    expectTypeOf<T.ConflictReason>().toExtend<T.ApiErrorReason>();
    expectTypeOf<T.NotFoundReason>().toExtend<T.ApiErrorReason>();
    expectTypeOf<T.ProjectDto['teamId']>().toEqualTypeOf<string | null>();
    expectTypeOf<T.ProjectDto['status']>().toEqualTypeOf<'active' | 'archived'>();
    expectTypeOf<T.TeamMemberDto['role']>().toEqualTypeOf<'lead' | 'member'>();
    expectTypeOf<T.EmployeeDto['email']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<T.ListProjectsResponse['nextCursor']>().toEqualTypeOf<string | null>();
  });
});
