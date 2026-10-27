import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMembershipRepository } from '../src/modules/organizations/infrastructure/in-memory.repositories.js';
import { buildApp, Client, PASSWORD, signupAndLogin, type App } from './helpers.js';

/** Root cause of the meetings 404: a fresh login had no active org. Login now picks one. */
describe('login sets a default active organization', () => {
  let app: App;
  let memberships: InMemoryMembershipRepository;
  beforeEach(async () => {
    memberships = new InMemoryMembershipRepository();
    app = await buildApp({ memberships });
  });
  afterEach(async () => app.close());

  const relogin = async (email: string) => {
    const c = new Client(app);
    const l = await c.post('/auth/login', { email, password: PASSWORD });
    expect(l.statusCode).toBe(200);
    return c;
  };
  const session = async (c: Client) =>
    (await c.get('/auth/session')).json<{
      activeOrganizationId: string | null;
      user: { id: string };
    }>();
  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;

  it('no memberships: no active org', async () => {
    const c = await signupAndLogin(app, 'none@example.com');
    expect((await session(c)).activeOrganizationId).toBeNull();
    expect((await session(await relogin('none@example.com'))).activeOrganizationId).toBeNull();
  });

  it('uses the last-used org when that membership is still valid', async () => {
    const c = await signupAndLogin(app, 'last@example.com');
    const a = await createOrg(c, 'A');
    const b = await createOrg(c, 'B');
    expect((await c.post('/orgs/switch', { organizationId: a })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: b })).statusCode).toBe(200);
    expect((await session(await relogin('last@example.com'))).activeOrganizationId).toBe(b);
  });

  it('falls back to the first membership when the last-used one was revoked', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const shared = await createOrg(owner, 'Shared');
    const c = await signupAndLogin(app, 'm@example.com');
    const own = await createOrg(c, 'Own');
    const own2 = await createOrg(c, 'Own2');
    // Join `shared` last so it is the last-used org, then remove the membership.
    const userId = (await session(c)).user.id;
    expect(
      (await owner.post(`/orgs/${shared}/invitations`, { email: 'm@example.com', role: 'member' }))
        .statusCode,
    ).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: shared })).statusCode).toBe(200);
    expect((await session(await relogin('m@example.com'))).activeOrganizationId).toBe(shared);
    await memberships.remove(shared, userId, new Date());
    const after = await session(await relogin('m@example.com'));
    // First live membership in deterministic order: oldest createdAt, then organizationId.
    const first = memberships.items
      .filter((m) => m.userId === userId && !m.deletedAt)
      .sort(
        (x, y) =>
          x.createdAt.getTime() - y.createdAt.getTime() ||
          x.organizationId.localeCompare(y.organizationId),
      )[0]!.organizationId;
    expect([own, own2]).toContain(first);
    expect(after.activeOrganizationId).toBe(first);
  });

  it('GET /orgs/:id/meetings is 200 right after login', async () => {
    const c = await signupAndLogin(app, 'meet@example.com');
    const org = await createOrg(c, 'Meet');
    const fresh = await relogin('meet@example.com');
    expect((await session(fresh)).activeOrganizationId).toBe(org);
    expect((await fresh.get(`/orgs/${org}/meetings`)).statusCode).toBe(200);
  });
});
