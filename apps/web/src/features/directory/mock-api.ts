import { ApiError } from '@/lib/api/client';
import type { DirectoryApi } from './api';
import type {
  CursorPage,
  EmployeeDto,
  Id,
  ProjectDto,
  TeamDto,
  TeamMemberDto,
} from './contracts-shim';

/**
 * In-memory DirectoryApi (mocks first, until BE-3 lands). Mirrors the contract rules the UI depends on:
 * org scoping, cursor pages, 404 for unknown ids, 409 for a taken project key / team name / existing member.
 * Used by tests and, only when VITE_DIRECTORY_MOCKS=true in a dev build, by the app.
 */
export type MockDirectorySeed = {
  employees?: EmployeeDto[];
  teams?: TeamDto[];
  members?: TeamMemberDto[];
  projects?: ProjectDto[];
};

const DEFAULT_LIMIT = 25; // contracts DEFAULT_PAGE_LIMIT

let seq = 0;
function newId(): Id {
  seq += 1;
  return `90000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'Not found');
}
function conflict(): never {
  throw new ApiError(409, 'CONFLICT', 'Conflict');
}

function page<T>(items: T[], query?: { cursor?: string; limit?: number }): CursorPage<T> {
  const start = query?.cursor ? Number(query.cursor) : 0;
  const limit = query?.limit ?? DEFAULT_LIMIT;
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return { items: slice, nextCursor: next < items.length ? String(next) : null };
}

function matches(q: string | undefined, ...fields: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

/** Drop `undefined` values so optional fields stay absent; `null` (clear) is kept. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export type MockDirectoryOptions = {
  now?: () => string;
  /** Lazily seed an org the first time any call touches it (dev mock mode). */
  seedOrg?: (orgId: Id) => MockDirectorySeed;
};

export function createMockDirectoryApi(
  seed: MockDirectorySeed = {},
  { now = () => new Date().toISOString(), seedOrg }: MockDirectoryOptions = {},
): DirectoryApi {
  let employees = [...(seed.employees ?? [])];
  let teams = [...(seed.teams ?? [])];
  let members = [...(seed.members ?? [])];
  let projects = [...(seed.projects ?? [])];
  const seeded = new Set<Id>();
  const ensure = (orgId: Id) => {
    if (!seedOrg || seeded.has(orgId)) return;
    seeded.add(orgId);
    const s = seedOrg(orgId);
    employees = [...employees, ...(s.employees ?? [])];
    teams = [...teams, ...(s.teams ?? [])];
    members = [...members, ...(s.members ?? [])];
    projects = [...projects, ...(s.projects ?? [])];
  };

  const employee = (orgId: Id, id: Id) =>
    employees.find((e) => e.organizationId === orgId && e.id === id) ?? notFound();
  const team = (orgId: Id, id: Id) =>
    teams.find((t) => t.organizationId === orgId && t.id === id) ?? notFound();
  const project = (orgId: Id, id: Id) =>
    projects.find((p) => p.organizationId === orgId && p.id === id) ?? notFound();
  const member = (orgId: Id, teamId: Id, employeeId: Id) =>
    members.find(
      (m) => m.organizationId === orgId && m.teamId === teamId && m.employeeId === employeeId,
    ) ?? notFound();

  const api: DirectoryApi = {
    employees: {
      list: async (orgId, q) =>
        page(
          employees.filter(
            (e) => e.organizationId === orgId && matches(q?.q, e.fullName, e.email, e.title),
          ),
          q,
        ),
      get: async (orgId, id) => employee(orgId, id),
      create: async (orgId, body) => {
        const t = now();
        const row: EmployeeDto = {
          id: newId(),
          organizationId: orgId,
          userId: body.userId ?? null,
          fullName: body.fullName,
          email: body.email ?? null,
          title: body.title ?? null,
          department: body.department ?? null,
          externalId: body.externalId ?? null,
          createdAt: t,
          updatedAt: t,
        };
        employees = [...employees, row];
        return row;
      },
      update: async (orgId, id, body) => {
        const row = { ...employee(orgId, id), ...defined(body), updatedAt: now() };
        employees = employees.map((e) => (e.id === id ? row : e));
        members = members.map((m) => (m.employeeId === id ? { ...m, employee: row } : m));
        return row;
      },
      remove: async (orgId, id) => {
        employee(orgId, id);
        employees = employees.filter((e) => e.id !== id);
        members = members.filter((m) => m.employeeId !== id);
      },
    },
    teams: {
      list: async (orgId, q) =>
        page(
          teams.filter((t) => t.organizationId === orgId && matches(q?.q, t.name, t.key)),
          q,
        ),
      get: async (orgId, id) => team(orgId, id),
      create: async (orgId, body) => {
        if (
          teams.some(
            (t) =>
              t.organizationId === orgId &&
              (t.name.toLowerCase() === body.name.toLowerCase() ||
                (body.key !== undefined && t.key === body.key)),
          )
        )
          conflict();
        const t = now();
        const row: TeamDto = {
          id: newId(),
          organizationId: orgId,
          name: body.name,
          key: body.key ?? null,
          description: body.description ?? null,
          createdAt: t,
          updatedAt: t,
        };
        teams = [...teams, row];
        return row;
      },
      update: async (orgId, id, body) => {
        const row = { ...team(orgId, id), ...defined(body), updatedAt: now() };
        teams = teams.map((t) => (t.id === id ? row : t));
        return row;
      },
      remove: async (orgId, id) => {
        team(orgId, id);
        teams = teams.filter((t) => t.id !== id);
        members = members.filter((m) => m.teamId !== id);
        projects = projects.map((p) => (p.teamId === id ? { ...p, teamId: null } : p));
      },
    },
    teamMembers: {
      list: async (orgId, teamId, q) => {
        team(orgId, teamId);
        return page(
          members.filter(
            (m) =>
              m.organizationId === orgId && m.teamId === teamId && (!q?.role || m.role === q.role),
          ),
          q,
        );
      },
      add: async (orgId, teamId, body) => {
        team(orgId, teamId);
        const emp = employee(orgId, body.employeeId);
        if (members.some((m) => m.teamId === teamId && m.employeeId === emp.id)) conflict();
        const row: TeamMemberDto = {
          organizationId: orgId,
          teamId,
          employeeId: emp.id,
          role: body.role ?? 'member',
          createdAt: now(),
          employee: emp,
        };
        members = [...members, row];
        return row;
      },
      update: async (orgId, teamId, employeeId, body) => {
        const row = { ...member(orgId, teamId, employeeId), role: body.role };
        members = members.map((m) =>
          m.teamId === teamId && m.employeeId === employeeId ? row : m,
        );
        return row;
      },
      remove: async (orgId, teamId, employeeId) => {
        member(orgId, teamId, employeeId);
        members = members.filter((m) => !(m.teamId === teamId && m.employeeId === employeeId));
      },
    },
    projects: {
      list: async (orgId, q) =>
        page(
          projects.filter(
            (p) =>
              p.organizationId === orgId &&
              (!q?.status || p.status === q.status) &&
              (!q?.teamId || p.teamId === q.teamId) &&
              matches(q?.q, p.name, p.key),
          ),
          q,
        ),
      get: async (orgId, id) => project(orgId, id),
      create: async (orgId, body) => {
        if (projects.some((p) => p.organizationId === orgId && p.key === body.key)) conflict();
        if (body.teamId) team(orgId, body.teamId);
        const t = now();
        const row: ProjectDto = {
          id: newId(),
          organizationId: orgId,
          name: body.name,
          key: body.key,
          description: body.description ?? null,
          status: 'active',
          teamId: body.teamId ?? null,
          createdAt: t,
          updatedAt: t,
        };
        projects = [...projects, row];
        return row;
      },
      update: async (orgId, id, body) => {
        if (body.teamId) team(orgId, body.teamId);
        const row = { ...project(orgId, id), ...defined(body), updatedAt: now() };
        projects = projects.map((p) => (p.id === id ? row : p));
        return row;
      },
      remove: async (orgId, id) => {
        project(orgId, id);
        projects = projects.filter((p) => p.id !== id);
      },
    },
  };
  return seedOrg ? withEnsure(api, ensure) : api;
}

/** Wrap every method so its first argument (the org id) is seeded before the call. */
function withEnsure(api: DirectoryApi, ensure: (orgId: Id) => void): DirectoryApi {
  type Fn = (orgId: Id, ...rest: unknown[]) => unknown;
  const wrap = (group: Record<string, Fn>) =>
    Object.fromEntries(
      Object.entries(group).map(([name, fn]) => [
        name,
        (orgId: Id, ...rest: unknown[]) => {
          ensure(orgId);
          return fn(orgId, ...rest);
        },
      ]),
    );
  return Object.fromEntries(
    Object.entries(api).map(([k, group]) => [k, wrap(group as Record<string, Fn>)]),
  ) as DirectoryApi;
}

/** Small demo directory for one org (dev mock mode only). */
export function demoDirectorySeed(orgId: Id): MockDirectorySeed {
  const t = '2026-10-01T00:00:00.000Z';
  const emp = (id: string, fullName: string, title: string, department: string): EmployeeDto => ({
    id,
    organizationId: orgId,
    userId: null,
    fullName,
    email: `${fullName.split(' ')[0]?.toLowerCase() ?? 'user'}@example.com`,
    title,
    department,
    externalId: null,
    createdAt: t,
    updatedAt: t,
  });
  const e1 = emp('91000000-0000-4000-8000-000000000001', 'Grace Hopper', 'Staff Engineer', 'Eng');
  const e2 = emp('91000000-0000-4000-8000-000000000002', 'Alan Turing', 'Researcher', 'R&D');
  const team1: TeamDto = {
    id: '92000000-0000-4000-8000-000000000001',
    organizationId: orgId,
    name: 'Platform',
    key: 'PLAT',
    description: 'Core services',
    createdAt: t,
    updatedAt: t,
  };
  return {
    employees: [e1, e2],
    teams: [team1],
    members: [
      {
        organizationId: orgId,
        teamId: team1.id,
        employeeId: e1.id,
        role: 'lead',
        createdAt: t,
        employee: e1,
      },
    ],
    projects: [
      {
        id: '93000000-0000-4000-8000-000000000001',
        organizationId: orgId,
        name: 'Launch',
        key: 'LAUNCH',
        description: null,
        status: 'active',
        teamId: team1.id,
        createdAt: t,
        updatedAt: t,
      },
    ],
  };
}
