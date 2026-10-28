import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryOrganizationRepository } from '../src/modules/organizations/infrastructure/in-memory.repositories.js';
import { buildApp, signupAndLogin, CSRF, SID, type App, type Client } from './helpers.js';

describe('organizations', () => {
  let app: App;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) => (await c.post('/orgs', { name })).json();

  it('requires authentication', async () => {
    const c = await signupAndLogin(app, 'a@example.com');
    await c.post('/auth/logout');
    await c.csrf();
    expect((await c.post('/orgs', { name: 'X' })).statusCode).toBe(401);
    expect((await c.get('/orgs')).statusCode).toBe(401);
  });

  it('requires CSRF on org mutations', async () => {
    const c = await signupAndLogin(app, 'a@example.com');
    const res = await c.post('/orgs', { name: 'X' }, { 'x-csrf-token': 'wrong' });
    expect(res.statusCode).toBe(403);
  });

  it('creates an org, makes the creator owner, activates it and rotates the session', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const before = c.cookie;
    const res = await c.post('/orgs', { name: 'Acme Inc' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe('owner');
    expect(body.organization).toMatchObject({ name: 'Acme Inc', slug: 'acme-inc' });
    expect(body.organization.updatedAt).toBeTypeOf('string');
    expect(c.cookie).not.toBe(before);

    const old = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: before },
    });
    expect(old.statusCode).toBe(401);
    const s = (await c.get('/auth/session')).json();
    expect(s.activeOrganizationId).toBe(body.organization.id);
    expect(s.memberships[0]).toMatchObject({ organizationId: body.organization.id, role: 'owner' });

    const list = (await c.get('/orgs')).json();
    expect(list).toMatchObject({ nextCursor: null });
    expect(list.items).toHaveLength(1);
  });

  it('switches the active org when the user is a member', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const first = await createOrg(c, 'One');
    await createOrg(c, 'Two');
    const res = await c.post('/orgs/switch', { organizationId: first.organization.id });
    expect(res.statusCode).toBe(200);
    expect((await c.get('/auth/session')).json().activeOrganizationId).toBe(first.organization.id);
  });

  it('404s switching to or reading another org (indistinguishable from unknown)', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Private');
    const outsider = await signupAndLogin(app, 'outsider@example.com');
    const a = await outsider.post('/orgs/switch', { organizationId: org.organization.id });
    const b = await outsider.post('/orgs/switch', { organizationId: randomUUID() });
    const g = await outsider.get(`/orgs/${org.organization.id}`);
    for (const r of [a, b, g]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('NOT_FOUND');
    }
    expect(a.json().error.message).toBe(b.json().error.message);
    expect((await outsider.get('/auth/session')).json().activeOrganizationId).toBeNull();
  });

  it('invites (owner), emails the token, never returns it, and the invitee accepts', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const inv = await owner.post(`/orgs/${org.organization.id}/invitations`, {
      email: 'New@Example.com',
      role: 'member',
    });
    expect(inv.statusCode).toBe(201);
    expect(inv.json()).toMatchObject({
      email: 'new@example.com',
      role: 'member',
      status: 'pending',
      organizationId: org.organization.id,
    });
    expect(inv.body).not.toMatch(/token/i);
    const token = new URL(
      [...app.mail.sent].reverse().find((m) => m.template === 'invitation')!.data.url!,
    ).searchParams.get('token')!;

    const wrongUser = await signupAndLogin(app, 'someone@example.com');
    const mismatch = await wrongUser.post('/invitations/accept', { token });
    const unknown = await wrongUser.post('/invitations/accept', { token: 'x'.repeat(48) });
    expect(mismatch.statusCode).toBe(404);
    expect(mismatch.body.replace(/"requestId":"[^"]+"/, '')).toBe(
      unknown.body.replace(/"requestId":"[^"]+"/, ''),
    );

    const invitee = await signupAndLogin(app, 'new@example.com');
    const ok = await invitee.post('/invitations/accept', { token });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().role).toBe('member');
    expect((await invitee.post('/invitations/accept', { token })).statusCode).toBe(404);
  });

  it('invite response is identical for existing and new addresses', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    await signupAndLogin(app, 'exists@example.com');
    const org = await createOrg(owner, 'Acme');
    const strip = (b: string) => b.replace(/"(id|expiresAt|email)":"[^"]+"/g, '');
    const a = await owner.post(`/orgs/${org.organization.id}/invitations`, {
      email: 'exists@example.com',
      role: 'viewer',
    });
    const b = await owner.post(`/orgs/${org.organization.id}/invitations`, {
      email: 'ghost@example.com',
      role: 'viewer',
    });
    expect(a.statusCode).toBe(b.statusCode);
    expect(strip(a.body)).toBe(strip(b.body));
  });

  it('enforces CASL: members cannot invite, outsiders get 404, owners can revoke', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const id = org.organization.id;
    await owner.post(`/orgs/${id}/invitations`, { email: 'm@example.com', role: 'member' });
    const member = await signupAndLogin(app, 'm@example.com');
    await member.post('/invitations/accept', {
      token: new URL(
        [...app.mail.sent].reverse().find((m) => m.template === 'invitation')!.data.url!,
      ).searchParams.get('token')!,
    });

    const denied = await member.post(`/orgs/${id}/invitations`, {
      email: 'y@example.com',
      role: 'viewer',
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    const outsider = await signupAndLogin(app, 'x@example.com');
    expect(
      (await outsider.post(`/orgs/${id}/invitations`, { email: 'y@example.com', role: 'viewer' }))
        .statusCode,
    ).toBe(404);

    const pending = (
      await owner.post(`/orgs/${id}/invitations`, { email: 'p@example.com', role: 'viewer' })
    ).json();
    expect((await member.post(`/orgs/${id}/invitations/${pending.id}/revoke`)).statusCode).toBe(
      403,
    );
    expect((await outsider.post(`/orgs/${id}/invitations/${pending.id}/revoke`)).statusCode).toBe(
      404,
    );
    const revoked = await owner.post(`/orgs/${id}/invitations/${pending.id}/revoke`);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('revoked');
  });

  it('cannot revoke an invitation through a different org (tenant scoping)', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const a = await createOrg(owner, 'A');
    const b = await createOrg(owner, 'B');
    const inv = (
      await owner.post(`/orgs/${a.organization.id}/invitations`, {
        email: 'p@example.com',
        role: 'viewer',
      })
    ).json();
    const res = await owner.post(`/orgs/${b.organization.id}/invitations/${inv.id}/revoke`);
    expect(res.statusCode).toBe(404);
  });

  it('POST /orgs/switch rotates the session (FE-2): new cookie + CSRF, old session revoked', async () => {
    const c = await signupAndLogin(app, 'switch-rot@example.com');
    const a = (await c.post('/orgs', { name: 'A' })).json().organization.id as string;
    const b = (await c.post('/orgs', { name: 'B' })).json().organization.id as string;
    const oldSid = c.jar.get(SID)!;
    const oldCsrf = c.jar.get(CSRF)!;
    const r = await c.post('/orgs/switch', { organizationId: a });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ organization: { id: a }, role: 'owner' });
    expect(c.jar.get(SID)).not.toBe(oldSid);
    expect(c.jar.get(CSRF)).not.toBe(oldCsrf);
    expect((await c.get('/auth/session')).json().activeOrganizationId).toBe(a);
    const stale = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: `${SID}=${oldSid}` },
    });
    expect(stale.statusCode).toBe(401);
    expect(b).not.toBe(a);
  });

  it('#302 L-2b: losing the slug check-then-insert race returns 409, not 500', async () => {
    const a = await signupAndLogin(app, 'race-a@example.com');
    const b = await signupAndLogin(app, 'race-b@example.com');
    expect((await a.post('/orgs', { name: 'Racy Org' })).statusCode).toBe(201);
    // Simulate the race window: the pre-check saw no row, the insert hits the unique slug.
    const spy = vi
      .spyOn(InMemoryOrganizationRepository.prototype, 'slugExists')
      .mockResolvedValue(false);
    try {
      const lost = await b.post('/orgs', { name: 'Racy Org' });
      expect(lost.statusCode).toBe(409);
      expect(lost.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    } finally {
      spy.mockRestore();
    }
    expect((await b.post('/orgs', { name: 'Racy Org' })).statusCode).toBe(201);
  });
});
