import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { createHttpDirectoryApi, directoryPath, toQueryString } from '@/features/directory/api';
import { DIRECTORY_PATHS } from '@/features/directory/contracts-shim';
import { createMockDirectoryApi } from '@/features/directory/mock-api';
import {
  employeeFormSchema,
  projectFormSchema,
  teamFormSchema,
  toSearchQuery,
} from '@/features/directory/schemas';
import { directorySeed, grace, launch, ORG_A, ORG_B, platform } from './fixtures/directory';

describe('directory http client', () => {
  const setup = () => {
    const request = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    return { request, api: createHttpDirectoryApi(request) };
  };

  it('builds contract paths with encoded params', () => {
    expect(
      directoryPath(DIRECTORY_PATHS.teamMember, {
        organizationId: 'o',
        teamId: 't/1',
        employeeId: 'e',
      }),
    ).toBe('/orgs/o/teams/t%2F1/members/e');
    expect(() => directoryPath(DIRECTORY_PATHS.team, { organizationId: 'o' })).toThrow(/teamId/);
  });

  it('omits empty query values', () => {
    expect(toQueryString(undefined)).toBe('');
    expect(toQueryString({ q: '', cursor: undefined, limit: 10, status: 'active' })).toBe(
      '?limit=10&status=active',
    );
  });

  it('maps every call to its method and path', async () => {
    const { request, api } = setup();
    await api.employees.list(ORG_A, { q: 'gr ace', limit: 5 });
    await api.employees.create(ORG_A, { fullName: 'X' });
    await api.employees.update(ORG_A, 'e1', { title: null });
    await api.employees.remove(ORG_A, 'e1');
    await api.teams.get(ORG_A, 't1');
    await api.teamMembers.add(ORG_A, 't1', { employeeId: 'e1' });
    await api.teamMembers.update(ORG_A, 't1', 'e1', { role: 'lead' });
    await api.teamMembers.remove(ORG_A, 't1', 'e1');
    await api.projects.list(ORG_A, { status: 'archived', cursor: 'c2' });
    await api.projects.update(ORG_A, 'p1', { status: 'archived' });
    const base = `/orgs/${ORG_A}`;
    expect(request.mock.calls).toEqual([
      ['GET', `${base}/employees?q=gr+ace&limit=5`],
      ['POST', `${base}/employees`, { fullName: 'X' }],
      ['PATCH', `${base}/employees/e1`, { title: null }],
      ['DELETE', `${base}/employees/e1`],
      ['GET', `${base}/teams/t1`],
      ['POST', `${base}/teams/t1/members`, { employeeId: 'e1' }],
      ['PATCH', `${base}/teams/t1/members/e1`, { role: 'lead' }],
      ['DELETE', `${base}/teams/t1/members/e1`],
      ['GET', `${base}/projects?status=archived&cursor=c2`],
      ['PATCH', `${base}/projects/p1`, { status: 'archived' }],
    ]);
  });
});

describe('in-memory directory mock', () => {
  it('scopes every read to the organization', async () => {
    const api = createMockDirectoryApi(directorySeed());
    const a = await api.projects.list(ORG_A);
    expect(a.items.map((p) => p.key)).toEqual(['LAUNCH', 'OLD']);
    const b = await api.projects.list(ORG_B);
    expect(b.items.map((p) => p.key)).toEqual(['SECRET']);
    await expect(api.teams.get(ORG_B, platform.id)).rejects.toMatchObject({ status: 404 });
    await expect(api.employees.remove(ORG_B, grace.id)).rejects.toBeInstanceOf(ApiError);
  });

  it('pages with an opaque cursor', async () => {
    const api = createMockDirectoryApi(directorySeed());
    const first = await api.employees.list(ORG_A, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await api.employees.list(ORG_A, { limit: 1, cursor: first.nextCursor ?? '' });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a taken project key and an existing team member with 409', async () => {
    const api = createMockDirectoryApi(directorySeed());
    await expect(
      api.projects.create(ORG_A, { name: 'Again', key: launch.key }),
    ).rejects.toMatchObject({
      status: 409,
    });
    // Same key in another org is fine.
    await expect(api.projects.create(ORG_B, { name: 'B', key: launch.key })).resolves.toMatchObject(
      {
        organizationId: ORG_B,
        status: 'active',
      },
    );
    await expect(
      api.teamMembers.add(ORG_A, platform.id, { employeeId: grace.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('deleting a team removes its members and unlinks its projects', async () => {
    const api = createMockDirectoryApi(directorySeed());
    await api.teams.remove(ORG_A, platform.id);
    await expect(api.teamMembers.list(ORG_A, platform.id)).rejects.toMatchObject({ status: 404 });
    expect((await api.projects.get(ORG_A, launch.id)).teamId).toBeNull();
  });

  it('seeds an org lazily in dev mode', async () => {
    const seedOrg = vi.fn(() => ({ teams: [{ ...platform, organizationId: ORG_B }] }));
    const api = createMockDirectoryApi({}, { seedOrg });
    expect((await api.teams.list(ORG_B)).items).toHaveLength(1);
    await api.teams.list(ORG_B);
    expect(seedOrg).toHaveBeenCalledTimes(1);
  });
});

describe('directory form schemas', () => {
  it('validates project keys like DIRECTORY_KEY_PATTERN', () => {
    const ok = (key: string) =>
      projectFormSchema.safeParse({ name: 'P', key, description: '', teamId: '' }).success;
    expect(ok('AB')).toBe(true);
    expect(ok('A1234567890')).toBe(false);
    expect(ok('ab')).toBe(false);
    expect(ok('1AB')).toBe(false);
    expect(ok('A')).toBe(false);
  });

  it('rejects unsafe display text but allows prose in descriptions', () => {
    expect(teamFormSchema.safeParse({ name: '<b>x</b>', key: '', description: '' }).success).toBe(
      false,
    );
    expect(teamFormSchema.safeParse({ name: 'Ops\u202E', key: '', description: '' }).success).toBe(
      false,
    );
    expect(
      teamFormSchema.safeParse({ name: 'Ops', key: '', description: "Tom's <team> & co\nline 2" })
        .success,
    ).toBe(true);
  });

  it('treats empty optional employee fields as absent and checks email', () => {
    const base = { fullName: 'Ada', email: '', title: '', department: '' };
    expect(employeeFormSchema.safeParse(base).success).toBe(true);
    expect(employeeFormSchema.safeParse({ ...base, email: 'nope' }).success).toBe(false);
    expect(employeeFormSchema.safeParse({ ...base, fullName: '   ' }).success).toBe(false);
  });

  it('drops unsafe or empty search text instead of sending it', () => {
    expect(toSearchQuery('  ')).toEqual({});
    expect(toSearchQuery('a<b')).toEqual({});
    expect(toSearchQuery(' plat ')).toEqual({ q: 'plat' });
  });
});
