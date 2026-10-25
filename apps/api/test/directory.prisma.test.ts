import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryError } from '@meetops/database';
import type { DatabaseClient } from '../src/shared/prisma/context.js';
import {
  selectDirectoryRepositories,
  type DirectoryModuleDeps,
} from '../src/modules/directory/index.js';
import { InMemoryDirectory } from '../src/modules/directory/in-memory.repositories.js';
import { createPrismaDirectory } from '../src/modules/directory/prisma.repositories.js';
import { toDirectoryError } from '../src/modules/directory/errors.js';
import { MissingProductionDependencyError } from '../src/modules/index.js';
import type { DomainError } from '../src/shared/domain-error.js';

/**
 * Unit tests for the DB-2 adapter: the @meetops/database repository factories are replaced by spies,
 * so these run without Postgres. The live round trip is in directory.prisma.integration.test.ts.
 */
const fakes = vi.hoisted(() => {
  const repo = () => ({
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    add: vi.fn(),
    updateRole: vi.fn(),
    remove: vi.fn(),
  });
  return {
    employees: repo(),
    teams: repo(),
    members: repo(),
    projects: repo(),
    options: [] as unknown[],
  };
});

vi.mock('@meetops/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meetops/database')>();
  const factory = (r: unknown) => (options: unknown) => {
    fakes.options.push(options);
    return r;
  };
  return {
    ...actual,
    createEmployeeRepository: factory(fakes.employees),
    createTeamRepository: factory(fakes.teams),
    createTeamMemberRepository: factory(fakes.members),
    createProjectRepository: factory(fakes.projects),
  };
});

const client = { fake: 'prisma' } as unknown as DatabaseClient;
const ORG = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';
const TEAM = '00000000-0000-4000-8000-000000000003';

/** What the routes would answer for an adapter error. */
async function httpOf(p: Promise<unknown>) {
  const e = toDirectoryError(
    await p.then(
      () => undefined,
      (err: unknown) => err,
    ),
  ) as DomainError;
  return { status: e.statusCode, code: e.code, reason: e.reason };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.options.length = 0;
});

describe('selectDirectoryRepositories', () => {
  const base = { clock: { now: () => new Date() } } as unknown as DirectoryModuleDeps;

  it('injected repositories win over a database client', () => {
    const injected = new InMemoryDirectory(() => new Date());
    expect(
      selectDirectoryRepositories({ ...base, directory: injected, db: client }, 'production'),
    ).toBe(injected);
  });

  it('uses the DB-2 Prisma repositories with the configured client when deps.db is set', async () => {
    const repos = selectDirectoryRepositories({ ...base, db: client }, 'production');
    expect(repos).not.toBeInstanceOf(InMemoryDirectory);
    expect(fakes.options).toEqual([{ client }, { client }, { client }, { client }]);
    fakes.employees.get.mockResolvedValue(null);
    expect(await repos.employees.findById(ORG, ID)).toBeNull();
    expect(fakes.employees.get).toHaveBeenCalledWith(ORG, ID);
  });

  it('falls back to memory only in development/test and fails closed elsewhere', () => {
    expect(selectDirectoryRepositories(base, 'test')).toBeInstanceOf(InMemoryDirectory);
    expect(() => selectDirectoryRepositories(base, 'production')).toThrow(
      MissingProductionDependencyError,
    );
    expect(() => selectDirectoryRepositories(base, 'staging')).toThrow(
      MissingProductionDependencyError,
    );
  });
});

describe('createPrismaDirectory', () => {
  const repos = createPrismaDirectory(client);

  it.each([
    ['PROJECT_KEY_TAKEN', 409, 'CONFLICT', 'PROJECT_KEY_TAKEN'],
    ['TEAM_MEMBER_EXISTS', 409, 'CONFLICT', 'TEAM_MEMBER_EXISTS'],
    ['TEAM_NAME_TAKEN', 409, 'CONFLICT', 'CONFLICT'],
    ['EMPLOYEE_EMAIL_TAKEN', 409, 'CONFLICT', 'CONFLICT'],
    ['EMPLOYEE_USER_TAKEN', 409, 'CONFLICT', 'CONFLICT'],
    ['TEAM_NOT_FOUND', 404, 'NOT_FOUND', 'TEAM_NOT_FOUND'],
    ['EMPLOYEE_NOT_FOUND', 404, 'NOT_FOUND', 'EMPLOYEE_NOT_FOUND'],
    ['USER_NOT_MEMBER', 404, 'NOT_FOUND', undefined],
    ['INVALID_CURSOR', 400, 'BAD_REQUEST', undefined],
  ] as const)('maps DirectoryError(%s) to %i %s/%s', async (reason, status, code, apiReason) => {
    fakes.projects.create.mockRejectedValue(new DirectoryError(reason));
    expect(await httpOf(repos.projects.create(ORG, { name: 'P', key: 'PK' }))).toEqual({
      status,
      code,
      reason: apiReason,
    });
  });

  it('rethrows unexpected errors untouched', async () => {
    const boom = new Error('connection reset');
    fakes.teams.list.mockRejectedValue(boom);
    await expect(repos.teams.list(ORG, { limit: 25 })).rejects.toBe(boom);
  });

  it('drops nulls on create and undefined keys on update and list', async () => {
    fakes.employees.create.mockResolvedValue({});
    await repos.employees.create(ORG, {
      fullName: 'Ada',
      email: null,
      title: 'Eng',
      userId: undefined,
    });
    expect(fakes.employees.create).toHaveBeenCalledWith(ORG, { fullName: 'Ada', title: 'Eng' });

    fakes.employees.update.mockResolvedValue(null);
    await repos.employees.update(ORG, ID, { email: null, title: undefined });
    expect(fakes.employees.update).toHaveBeenCalledWith(ORG, ID, { email: null });

    fakes.projects.list.mockResolvedValue({ items: [], nextCursor: null });
    await repos.projects.list(ORG, { limit: 10, cursor: undefined, status: 'active' });
    expect(fakes.projects.list).toHaveBeenCalledWith(ORG, { limit: 10, status: 'active' });
  });

  it('a member list of a missing team is TEAM_NOT_FOUND', async () => {
    fakes.members.list.mockResolvedValue(null);
    expect(await httpOf(repos.teamMembers.list(ORG, TEAM, { limit: 25 }))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
      reason: 'TEAM_NOT_FOUND',
    });
  });

  it('deleting a team is one DB-2 call (it unlinks the projects in the same transaction)', async () => {
    fakes.teams.softDelete.mockResolvedValue(true);
    expect(await repos.teams.softDelete(ORG, TEAM)).toBe(true);
    expect(fakes.teams.softDelete).toHaveBeenCalledExactlyOnceWith(ORG, TEAM);
    expect(fakes.projects.list).not.toHaveBeenCalled();
    expect(fakes.projects.update).not.toHaveBeenCalled();
  });

  it('deleting a missing team reports false and touches no projects', async () => {
    fakes.teams.softDelete.mockResolvedValue(false);
    expect(await repos.teams.softDelete(ORG, TEAM)).toBe(false);
    expect(fakes.projects.list).not.toHaveBeenCalled();
    expect(fakes.projects.update).not.toHaveBeenCalled();
  });

  it('passes member writes straight through', async () => {
    fakes.members.add.mockResolvedValue({ teamId: TEAM });
    fakes.members.remove.mockResolvedValue(true);
    await repos.teamMembers.add(ORG, TEAM, ID, 'lead');
    expect(fakes.members.add).toHaveBeenCalledWith(ORG, TEAM, ID, 'lead');
    expect(await repos.teamMembers.remove(ORG, TEAM, ID)).toBe(true);
  });
});
