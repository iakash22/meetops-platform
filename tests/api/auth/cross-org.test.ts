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
    expect([403, 404]).toContain(r.statusCode);
    expect(errorCode(r)).toBe('NOT_FOUND');
    const s = await a.get('/auth/session');
    expect(JSON.stringify(s.json())).toContain(orgA.id);
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
    expect(JSON.stringify(s.json())).not.toContain(orgB.id);
  });
});
