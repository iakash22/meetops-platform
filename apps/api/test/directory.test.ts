import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ApiErrorEnvelope,
  EmployeeDto,
  ListEmployeesResponse,
  ListProjectsResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  ProjectDto,
  TeamDto,
  TeamMemberDto,
} from '@meetops/contracts';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryDirectory } from '../src/modules/directory/in-memory.repositories.js';
import { selectDirectoryRepositories } from '../src/modules/directory/index.js';
import { MissingProductionDependencyError, type ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const MISSING = '00000000-0000-4000-8000-0000000000ff';
type Role = 'admin' | 'member' | 'viewer';

describe('BE-3 directory API (employees, teams, members, projects)', () => {
  let app: App;
  let audit: InMemoryAuditLog;
  let directory: InMemoryDirectory;
  beforeEach(async () => {
    audit = new InMemoryAuditLog();
    directory = new InMemoryDirectory();
    app = await buildApp({ audit, directory } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;

  /** Invite `email` into `orgId` with `role`, accept, and make it the active org. */
  async function join(owner: Client, orgId: string, email: string, role: Role) {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }

  async function world() {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const admin = await join(owner, org, 'admin@example.com', 'admin');
    const member = await join(owner, org, 'member@example.com', 'member');
    const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Globex');
    return { owner, org, admin, member, viewer, other, otherOrg };
  }

  const errorOf = (r: { json: () => unknown }) => {
    const body = r.json();
    expect(Value.Check(ApiErrorEnvelope, body)).toBe(true);
    return (body as { error: { code: string; reason?: string } }).error;
  };

  it('owner/admin CRUD employees with contract-valid responses, audit rows and soft delete', async () => {
    const { owner, admin, org } = await world();
    const base = `/orgs/${org}/employees`;
    const created = await admin.post(base, {
      fullName: 'Ada Lovelace',
      email: 'ada@acme.test',
      title: 'Eng',
    });
    expect(created.statusCode).toBe(201);
    expect(Value.Check(EmployeeDto, created.json())).toBe(true);
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({
      organizationId: org,
      email: 'ada@acme.test',
      department: null,
    });

    const got = await owner.get(`${base}/${id}`);
    expect(got.statusCode).toBe(200);
    expect(Value.Check(EmployeeDto, got.json())).toBe(true);

    const patched = await owner.patch(`${base}/${id}`, { title: null, department: 'Research' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ title: null, department: 'Research' });

    const list = await owner.get(`${base}?q=ada`);
    expect(Value.Check(ListEmployeesResponse, list.json())).toBe(true);
    expect(list.json().items).toHaveLength(1);

    expect((await owner.delete(`${base}/${id}`)).statusCode).toBe(204);
    const gone = await owner.get(`${base}/${id}`);
    expect(gone.statusCode).toBe(404);
    expect(errorOf(gone)).toMatchObject({ code: 'NOT_FOUND', reason: 'EMPLOYEE_NOT_FOUND' });
    expect((await owner.delete(`${base}/${id}`)).statusCode).toBe(404);

    const actions = audit.events.filter((e) => e.targetType === 'employee').map((e) => e.action);
    expect(actions).toEqual(['employee.create', 'employee.update', 'employee.delete']);
    const update = audit.events.find((e) => e.action === 'employee.update')!;
    expect(update).toMatchObject({
      organizationId: org,
      targetId: id,
      metadata: { fields: 'department,title' },
    });
    expect(JSON.stringify(audit.events)).not.toContain('ada@acme.test');
  });

  it('member and viewer can read but get 403 FORBIDDEN on every write; email is hidden from them', async () => {
    const { owner, member, viewer, org } = await world();
    const emp = (
      await owner.post(`/orgs/${org}/employees`, { fullName: 'Bob', email: 'bob@acme.test' })
    ).json();
    const team = (await owner.post(`/orgs/${org}/teams`, { name: 'Core' })).json();
    const project = (await owner.post(`/orgs/${org}/projects`, { name: 'Web', key: 'WEB' })).json();
    const before = audit.events.length;

    for (const c of [member, viewer]) {
      const read = await c.get(`/orgs/${org}/employees/${emp.id}`);
      expect(read.statusCode).toBe(200);
      expect(Value.Check(EmployeeDto, read.json())).toBe(true);
      expect(read.json()).not.toHaveProperty('email');
      expect((await c.get(`/orgs/${org}/employees`)).json().items[0]).not.toHaveProperty('email');
      expect((await c.get(`/orgs/${org}/teams/${team.id}`)).statusCode).toBe(200);
      expect((await c.get(`/orgs/${org}/projects/${project.id}`)).statusCode).toBe(200);

      const writes = [
        c.post(`/orgs/${org}/employees`, { fullName: 'X' }),
        c.patch(`/orgs/${org}/employees/${emp.id}`, { fullName: 'Y' }),
        c.delete(`/orgs/${org}/employees/${emp.id}`),
        c.post(`/orgs/${org}/teams`, { name: 'T2' }),
        c.patch(`/orgs/${org}/teams/${team.id}`, { name: 'T3' }),
        c.delete(`/orgs/${org}/teams/${team.id}`),
        c.post(`/orgs/${org}/teams/${team.id}/members`, { employeeId: emp.id }),
        c.patch(`/orgs/${org}/teams/${team.id}/members/${emp.id}`, { role: 'lead' }),
        c.delete(`/orgs/${org}/teams/${team.id}/members/${emp.id}`),
        c.post(`/orgs/${org}/projects`, { name: 'P', key: 'PP' }),
        c.patch(`/orgs/${org}/projects/${project.id}`, { status: 'archived' }),
        c.delete(`/orgs/${org}/projects/${project.id}`),
      ];
      for (const r of await Promise.all(writes)) {
        expect(r.statusCode).toBe(403);
        expect(errorOf(r).code).toBe('FORBIDDEN');
      }
    }
    expect(audit.events.length).toBe(before);
    expect((await owner.get(`/orgs/${org}/employees/${emp.id}`)).json()).toMatchObject({
      fullName: 'Bob',
    });
  });

  it('teams: 409 CONFLICT on a duplicate name; members add/list/role/remove with reasons', async () => {
    const { owner, admin, org } = await world();
    const team = await admin.post(`/orgs/${org}/teams`, { name: 'Platform', key: 'PLAT' });
    expect(team.statusCode).toBe(201);
    expect(Value.Check(TeamDto, team.json())).toBe(true);
    const tid = team.json().id as string;

    const dup = await owner.post(`/orgs/${org}/teams`, { name: 'Platform' });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup)).toMatchObject({ code: 'CONFLICT', reason: 'CONFLICT' });

    const emp = (
      await owner.post(`/orgs/${org}/employees`, { fullName: 'Cy', email: 'cy@acme.test' })
    ).json();
    const members = `/orgs/${org}/teams/${tid}/members`;
    const added = await admin.post(members, { employeeId: emp.id, role: 'lead' });
    expect(added.statusCode).toBe(201);
    expect(Value.Check(TeamMemberDto, added.json())).toBe(true);
    expect(added.json()).toMatchObject({ teamId: tid, employeeId: emp.id, role: 'lead' });

    const again = await admin.post(members, { employeeId: emp.id });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: 'CONFLICT', reason: 'TEAM_MEMBER_EXISTS' });

    const unknownEmp = await admin.post(members, { employeeId: MISSING });
    expect(unknownEmp.statusCode).toBe(404);
    expect(errorOf(unknownEmp).reason).toBe('EMPLOYEE_NOT_FOUND');
    const unknownTeam = await admin.post(`/orgs/${org}/teams/${MISSING}/members`, {
      employeeId: emp.id,
    });
    expect(errorOf(unknownTeam).reason).toBe('TEAM_NOT_FOUND');

    const list = await owner.get(`${members}?role=lead`);
    expect(Value.Check(ListTeamMembersResponse, list.json())).toBe(true);
    expect(list.json().items).toHaveLength(1);
    expect((await owner.get(`${members}?role=member`)).json().items).toHaveLength(0);

    const role = await owner.patch(`${members}/${emp.id}`, { role: 'member' });
    expect(role.statusCode).toBe(200);
    expect(role.json().role).toBe('member');
    expect((await owner.delete(`${members}/${emp.id}`)).statusCode).toBe(204);
    const removed = await owner.delete(`${members}/${emp.id}`);
    expect(removed.statusCode).toBe(404);
    expect(errorOf(removed).reason).toBe('EMPLOYEE_NOT_FOUND');

    expect((await owner.delete(`/orgs/${org}/teams/${tid}`)).statusCode).toBe(204);
    expect(errorOf(await owner.get(`/orgs/${org}/teams/${tid}`)).reason).toBe('TEAM_NOT_FOUND');
    expect(Value.Check(ListTeamsResponse, (await owner.get(`/orgs/${org}/teams`)).json())).toBe(
      true,
    );
    expect(audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'team.create',
        'team_member.add',
        'team_member.update',
        'team_member.remove',
        'team.delete',
      ]),
    );
  });

  it('projects: 409 PROJECT_KEY_TAKEN (also after soft delete), immutable key, filters, team must exist', async () => {
    const { owner, org } = await world();
    const team = (await owner.post(`/orgs/${org}/teams`, { name: 'Ops' })).json();
    const p = await owner.post(`/orgs/${org}/projects`, {
      name: 'Ops portal',
      key: 'OPS',
      teamId: team.id,
    });
    expect(p.statusCode).toBe(201);
    expect(Value.Check(ProjectDto, p.json())).toBe(true);
    expect(p.json()).toMatchObject({ status: 'active', teamId: team.id, description: null });
    const pid = p.json().id as string;

    const dup = await owner.post(`/orgs/${org}/projects`, { name: 'Other', key: 'OPS' });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup)).toMatchObject({ code: 'CONFLICT', reason: 'PROJECT_KEY_TAKEN' });

    const badTeam = await owner.post(`/orgs/${org}/projects`, {
      name: 'Z',
      key: 'ZZ',
      teamId: MISSING,
    });
    expect(badTeam.statusCode).toBe(404);
    expect(errorOf(badTeam).reason).toBe('TEAM_NOT_FOUND');

    expect((await owner.patch(`/orgs/${org}/projects/${pid}`, { key: 'NEW' })).statusCode).toBe(
      400,
    );
    const archived = await owner.patch(`/orgs/${org}/projects/${pid}`, { status: 'archived' });
    expect(archived.json().status).toBe('archived');

    const byStatus = await owner.get(`/orgs/${org}/projects?status=archived&teamId=${team.id}`);
    expect(Value.Check(ListProjectsResponse, byStatus.json())).toBe(true);
    expect(byStatus.json().items).toHaveLength(1);
    expect((await owner.get(`/orgs/${org}/projects?status=active`)).json().items).toHaveLength(0);

    expect((await owner.delete(`/orgs/${org}/projects/${pid}`)).statusCode).toBe(204);
    const gone = await owner.get(`/orgs/${org}/projects/${pid}`);
    expect(errorOf(gone)).toMatchObject({ code: 'NOT_FOUND', reason: 'PROJECT_NOT_FOUND' });
    const reuse = await owner.post(`/orgs/${org}/projects`, { name: 'Again', key: 'OPS' });
    expect(errorOf(reuse).reason).toBe('PROJECT_KEY_TAKEN');
    expect(audit.events.filter((e) => e.targetType === 'project').map((e) => e.action)).toEqual([
      'project.create',
      'project.update',
      'project.delete',
    ]);
  });

  it('employee conflicts: duplicate email 409 CONFLICT; userId must be an org member (404)', async () => {
    const { owner, org, member, other } = await world();
    await owner.post(`/orgs/${org}/employees`, { fullName: 'A', email: 'a@acme.test' });
    const dup = await owner.post(`/orgs/${org}/employees`, { fullName: 'B', email: 'a@acme.test' });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup)).toMatchObject({ code: 'CONFLICT', reason: 'CONFLICT' });

    const memberId = (await member.get('/auth/session')).json().user.id as string;
    const linked = await owner.post(`/orgs/${org}/employees`, { fullName: 'M', userId: memberId });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().userId).toBe(memberId);
    const twice = await owner.post(`/orgs/${org}/employees`, { fullName: 'M2', userId: memberId });
    expect(errorOf(twice)).toMatchObject({ code: 'CONFLICT', reason: 'CONFLICT' });

    const outsiderId = (await other.get('/auth/session')).json().user.id as string;
    const foreign = await owner.post(`/orgs/${org}/employees`, {
      fullName: 'O',
      userId: outsiderId,
    });
    expect(foreign.statusCode).toBe(404);
    expect(errorOf(foreign).code).toBe('NOT_FOUND');
  });

  it('tenant isolation: other-org paths and ids are 404 (same body as missing), before any role check', async () => {
    const { owner, org, other, otherOrg, viewer } = await world();
    const emp = (await owner.post(`/orgs/${org}/employees`, { fullName: 'Secret' })).json();
    const team = (await owner.post(`/orgs/${org}/teams`, { name: 'Secret team' })).json();
    const project = (
      await owner.post(`/orgs/${org}/projects`, { name: 'Secret', key: 'SEC' })
    ).json();
    const before = audit.events.length;

    const paths = [
      `/orgs/${org}/employees`,
      `/orgs/${org}/employees/${emp.id}`,
      `/orgs/${org}/teams/${team.id}`,
      `/orgs/${org}/teams/${team.id}/members`,
      `/orgs/${org}/projects/${project.id}`,
    ];
    for (const p of paths) {
      const r = await other.get(p);
      expect(r.statusCode).toBe(404);
      expect(errorOf(r).code).toBe('NOT_FOUND');
    }
    // Own-org path with another org's ids: indistinguishable from an unknown id.
    for (const [kind, id, reason, patch] of [
      ['employees', emp.id, 'EMPLOYEE_NOT_FOUND', { fullName: 'pwn' }],
      ['teams', team.id, 'TEAM_NOT_FOUND', { name: 'pwn' }],
      ['projects', project.id, 'PROJECT_NOT_FOUND', { name: 'pwn' }],
    ] as const) {
      const cross = await other.get(`/orgs/${otherOrg}/${kind}/${id}`);
      const missing = await other.get(`/orgs/${otherOrg}/${kind}/${MISSING}`);
      expect(cross.statusCode).toBe(404);
      expect(errorOf(cross).reason).toBe(reason);
      const strip = (b: { error: Record<string, unknown> }) => ({
        ...b.error,
        requestId: undefined,
      });
      expect(strip(cross.json())).toEqual(strip(missing.json()));
      expect((await other.patch(`/orgs/${otherOrg}/${kind}/${id}`, patch)).statusCode).toBe(404);
      expect((await other.delete(`/orgs/${otherOrg}/${kind}/${id}`)).statusCode).toBe(404);
    }
    // Writes into another org: 404 (not 403), and nothing changes.
    const write = await other.post(`/orgs/${org}/projects`, { name: 'X', key: 'XX' });
    expect(write.statusCode).toBe(404);
    expect(
      (await other.post(`/orgs/${otherOrg}/teams/${team.id}/members`, { employeeId: emp.id }))
        .statusCode,
    ).toBe(404);
    expect((await other.get(`/orgs/${otherOrg}/employees`)).json().items).toHaveLength(0);
    // A viewer of org A is a member there, but org B is still 404.
    expect((await viewer.get(`/orgs/${otherOrg}/employees`)).statusCode).toBe(404);
    expect(audit.events.slice(before).filter((e) => e.targetType !== 'session')).toHaveLength(0);
  });

  it('path org must be the active org, even for a member of both', async () => {
    const owner = await signupAndLogin(app, 'two@example.com');
    const first = await createOrg(owner, 'First');
    const second = await createOrg(owner, 'Second'); // now active
    expect((await owner.get(`/orgs/${second}/teams`)).statusCode).toBe(200);
    const r = await owner.get(`/orgs/${first}/teams`);
    expect(r.statusCode).toBe(404);
    expect(errorOf(r).code).toBe('NOT_FOUND');
  });

  it('401 without a session, CSRF on writes, 400 on invalid bodies and cursors', async () => {
    const { owner, org } = await world();
    expect((await app.inject({ method: 'GET', url: `/orgs/${org}/employees` })).statusCode).toBe(
      401,
    );
    const noCsrf = await owner.post(
      `/orgs/${org}/teams`,
      { name: 'T' },
      { 'x-csrf-token': 'wrong' },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(
      (await owner.post(`/orgs/${org}/projects`, { name: 'P', key: 'lower' })).statusCode,
    ).toBe(400);
    expect((await owner.patch(`/orgs/${org}/teams/${MISSING}`, {})).statusCode).toBe(400);
    expect(
      (await owner.post(`/orgs/${org}/employees`, { fullName: 'E', extra: 1 })).statusCode,
    ).toBe(400);
    const badCursor = await owner.get(`/orgs/${org}/employees?cursor=bm9wZQ`);
    expect(badCursor.statusCode).toBe(400);
    expect(errorOf(badCursor).code).toBe('BAD_REQUEST');
  });

  it('paginates with an opaque keyset cursor', async () => {
    const { owner, org } = await world();
    for (let i = 0; i < 5; i++) await owner.post(`/orgs/${org}/teams`, { name: `Team ${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `&cursor=${cursor}` : '';
      const page = await owner.get(`/orgs/${org}/teams?limit=2${qs}`);
      expect(page.statusCode).toBe(200);
      expect(Value.Check(ListTeamsResponse, page.json())).toBe(true);
      const body = page.json<{ items: { name: string }[]; nextCursor: string | null }>();
      seen.push(...body.items.map((t) => t.name));
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.sort()).toEqual(['Team 0', 'Team 1', 'Team 2', 'Team 3', 'Team 4']);
  });

  it('fails closed outside development/test without directory repositories', () => {
    const deps = {} as ModuleDeps;
    expect(() => selectDirectoryRepositories(deps, 'production')).toThrow(
      MissingProductionDependencyError,
    );
    expect(selectDirectoryRepositories({ ...deps, directory }, 'production')).toBe(directory);
  });
});
