import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthApp,
  comparableBody,
  errorCode,
  hasAuthApi,
  signupAndLogin,
  type InjectApp,
} from '../../support/api-app.js';

/*
 * XT-* that PR #27's endpoints can express (orgs, invitations, org switch). Meeting/task/
 * file/search XT cases have no endpoints yet; their DB-level equivalents live in
 * integration/xt-db.test.ts. Expected: 404 with code NOT_FOUND, same body as a missing id.
 */
let open: InjectApp[] = [];
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()));
  open = [];
});

async function twoOrgs() {
  const r = await buildAuthApp();
  open.push(r.app);
  const a = await signupAndLogin(r.app, `xt-a-${Math.random().toString(36).slice(2)}@example.test`);
  const b = await signupAndLogin(r.app, `xt-b-${Math.random().toString(36).slice(2)}@example.test`);
  const orgA = (await a.post('/orgs', { name: 'Org A' })).json().organization as { id: string };
  const orgB = (await b.post('/orgs', { name: 'Org B' })).json().organization as { id: string };
  return { ...r, a, b, orgA, orgB };
}

const MISSING = '00000000-0000-4000-8000-0000000000ff';

describe.skipIf(!hasAuthApi)('XT: cross-organization access via API (PR #27)', () => {
  it('[XT-01 analogue] GET /orgs/{B} as A is 404 NOT_FOUND, same body as a missing org', async () => {
    const { a, orgB } = await twoOrgs();
    const r = await a.get(`/orgs/${orgB.id}`);
    const missing = await a.get(`/orgs/${MISSING}`);
    expect(r.statusCode).toBe(404);
    expect(errorCode(r)).toBe('NOT_FOUND');
    expect(comparableBody(r)).toEqual(comparableBody(missing));
  });

  it('[XT-04 analogue] GET /orgs lists only A memberships', async () => {
    const { a, orgA, orgB } = await twoOrgs();
    const r = await a.get('/orgs');
    expect(r.statusCode).toBe(200);
    const ids = JSON.stringify(r.json());
    expect(ids).toContain(orgA.id);
    expect(ids).not.toContain(orgB.id);
  });

  it('[XT-21] POST /orgs/{B}/invitations as A is 404 NOT_FOUND and sends nothing', async () => {
    const { a, orgB, mailer } = await twoOrgs();
    const before = mailer.sent.length;
    const r = await a.post(`/orgs/${orgB.id}/invitations`, {
      email: 'victim@example.test',
      role: 'member',
    });
    expect(r.statusCode).toBe(404);
    expect(errorCode(r)).toBe('NOT_FOUND');
    expect(mailer.sent.length).toBe(before);
  });

  it('[XT-21] revoking a B invitation as A is 404 NOT_FOUND', async () => {
    const { a, b, orgB } = await twoOrgs();
    const inv = (
      await b.post(`/orgs/${orgB.id}/invitations`, { email: 'x@example.test', role: 'member' })
    ).json() as { id: string };
    const r = await a.post(`/orgs/${orgB.id}/invitations/${inv.id}/revoke`);
    expect(r.statusCode).toBe(404);
    expect(errorCode(r)).toBe('NOT_FOUND');
  });

  it('[XT-30] switching to B as a member of A only is 404 and the active org stays A', async () => {
    const { a, orgA, orgB } = await twoOrgs();
    expect((await a.post('/orgs/switch', { organizationId: orgA.id })).statusCode).toBe(200);
    const r = await a.post('/orgs/switch', { organizationId: orgB.id });
    expect(r.statusCode).toBe(404);
    expect(errorCode(r)).toBe('NOT_FOUND');
    const s = await a.get('/auth/session');
    expect(s.statusCode).toBe(200);
    expect(s.json().activeOrganizationId).toBe(orgA.id);
    expect(JSON.stringify(s.json())).not.toContain(orgB.id);
  });

  it('[XT-30] an X-Org-Id: B header does not change the context', async () => {
    const { a, orgA, orgB } = await twoOrgs();
    await a.post('/orgs/switch', { organizationId: orgA.id });
    const r = await a.post(
      `/orgs/${orgA.id}/invitations`,
      { email: 'h@example.test', role: 'member' },
      { 'x-org-id': orgB.id },
    );
    expect(r.statusCode).toBe(201);
    const s = await a.get('/auth/session');
    expect(s.json().activeOrganizationId).toBe(orgA.id);
    expect(JSON.stringify(s.json())).not.toContain(orgB.id);
  });

  // BE-3: directory (employees, teams, team members, projects). The path org must be the
  // caller's active org and every id must belong to it; anything else is 404, never 403.
  async function directoryInB() {
    const t = await twoOrgs();
    await t.a.post('/orgs/switch', { organizationId: t.orgA.id });
    await t.b.post('/orgs/switch', { organizationId: t.orgB.id });
    const base = `/orgs/${t.orgB.id}`;
    const emp = (
      await t.b.post(`${base}/employees`, { fullName: 'Bea B', email: 'bea@example.test' })
    ).json() as { id: string };
    const team = (await t.b.post(`${base}/teams`, { name: 'B Team' })).json() as { id: string };
    const project = (
      await t.b.post(`${base}/projects`, { name: 'B Project', key: 'BP' })
    ).json() as {
      id: string;
    };
    expect(
      (await t.b.post(`${base}/teams/${team.id}/members`, { employeeId: emp.id })).statusCode,
    ).toBe(201);
    return { ...t, emp, team, project };
  }

  it('[XT-DIR] reading B directory records as A is 404, same body as a missing id', async () => {
    const { a, orgA, orgB, emp, team, project } = await directoryInB();
    for (const [kind, id] of [
      ['employees', emp.id],
      ['teams', team.id],
      ['projects', project.id],
    ] as const) {
      // B's path: A is not a member of B.
      const viaB = await a.get(`/orgs/${orgB.id}/${kind}/${id}`);
      expect(viaB.statusCode).toBe(404);
      expect(errorCode(viaB)).toBe('NOT_FOUND');
      expect(comparableBody(viaB)).toEqual(
        comparableBody(await a.get(`/orgs/${orgB.id}/${kind}/${MISSING}`)),
      );
      // A's own path with B's id: indistinguishable from an unknown id.
      const viaA = await a.get(`/orgs/${orgA.id}/${kind}/${id}`);
      expect(viaA.statusCode).toBe(404);
      expect(errorCode(viaA)).toBe('NOT_FOUND');
      expect(comparableBody(viaA)).toEqual(
        comparableBody(await a.get(`/orgs/${orgA.id}/${kind}/${MISSING}`)),
      );
    }
    const list = await a.get(`/orgs/${orgB.id}/employees`);
    expect(list.statusCode).toBe(404);
    expect(errorCode(list)).toBe('NOT_FOUND');
    const members = await a.get(`/orgs/${orgA.id}/teams/${team.id}/members`);
    expect(members.statusCode).toBe(404);
  });

  it('[XT-DIR] writing B directory records as A is 404 and changes nothing', async () => {
    const { a, b, orgA, orgB, emp, team, project } = await directoryInB();
    const writes = [
      a.post(`/orgs/${orgB.id}/employees`, { fullName: 'X', email: 'x@example.test' }),
      a.patch(`/orgs/${orgB.id}/teams/${team.id}`, { name: 'pwned' }),
      a.patch(`/orgs/${orgA.id}/teams/${team.id}`, { name: 'pwned' }),
      a.delete(`/orgs/${orgA.id}/projects/${project.id}`),
      a.delete(`/orgs/${orgA.id}/employees/${emp.id}`),
      a.post(`/orgs/${orgA.id}/teams/${team.id}/members`, { employeeId: emp.id }),
      a.delete(`/orgs/${orgA.id}/teams/${team.id}/members/${emp.id}`),
    ];
    for (const r of await Promise.all(writes)) {
      expect(r.statusCode).toBe(404);
      expect(errorCode(r)).toBe('NOT_FOUND');
    }
    // A cannot attach B's team to an A project either.
    const linked = await a.post(`/orgs/${orgA.id}/projects`, {
      name: 'A Project',
      key: 'AP',
      teamId: team.id,
    });
    expect(linked.statusCode).toBe(404);
    const t = await b.get(`/orgs/${orgB.id}/teams/${team.id}`);
    expect(t.json().name).toBe('B Team');
    expect((await b.get(`/orgs/${orgB.id}/projects/${project.id}`)).statusCode).toBe(200);
    expect((await b.get(`/orgs/${orgB.id}/employees/${emp.id}`)).statusCode).toBe(200);
    const m = (await b.get(`/orgs/${orgB.id}/teams/${team.id}/members`)).json();
    expect(JSON.stringify(m)).toContain(emp.id);
  });
});
