/* eslint-disable @typescript-eslint/no-unsafe-argument -- test/ is not part of a TS project (see report) */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, signup, type App } from './helpers';

describe('organization routes', () => {
  let app: App;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => app.close());

  const createOrg = (cookie: string, name: string) =>
    app.inject({ method: 'POST', url: '/organizations', headers: { cookie }, payload: { name } });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/organizations', payload: { name: 'X' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates an org, makes the creator owner and activates it', async () => {
    const { cookie } = await signup(app, 'owner@example.com');
    const res = await createOrg(cookie, 'Acme Inc');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe('owner');
    expect(body.organization.slug).toBe('acme-inc');

    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(session.json().session.activeOrganizationId).toBe(body.organization.id);

    const list = await app.inject({ method: 'GET', url: '/organizations', headers: { cookie } });
    expect(list.json()).toHaveLength(1);
  });

  it('dedupes slugs', async () => {
    const { cookie } = await signup(app, 'owner@example.com');
    const a = (await createOrg(cookie, 'Acme')).json();
    const b = (await createOrg(cookie, 'Acme')).json();
    expect(a.organization.slug).toBe('acme');
    expect(b.organization.slug).not.toBe('acme');
  });

  it('switches active org when the user is a member', async () => {
    const { cookie } = await signup(app, 'owner@example.com');
    const first = (await createOrg(cookie, 'One')).json();
    await createOrg(cookie, 'Two');
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/switch',
      headers: { cookie },
      payload: { organizationId: first.organization.id }
    });
    expect(res.statusCode).toBe(200);
    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(session.json().session.activeOrganizationId).toBe(first.organization.id);
  });

  it('refuses to switch to an org the user is not a member of, and 404s for unknown orgs', async () => {
    const owner = await signup(app, 'owner@example.com');
    const org = (await createOrg(owner.cookie, 'Private')).json();
    const outsider = await signup(app, 'outsider@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/organizations/switch',
      headers: { cookie: outsider.cookie },
      payload: { organizationId: org.organization.id }
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MEMBER');
    const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: outsider.cookie } });
    expect(session.json().session.activeOrganizationId).toBeNull();

    const missing = await app.inject({
      method: 'POST',
      url: '/organizations/switch',
      headers: { cookie: outsider.cookie },
      payload: { organizationId: 'nope' }
    });
    expect(missing.statusCode).toBe(404);
  });

  it('lets an owner invite, and forbids a non-member from inviting', async () => {
    const owner = await signup(app, 'owner@example.com');
    const org = (await createOrg(owner.cookie, 'Acme')).json();
    const ok = await app.inject({
      method: 'POST',
      url: `/organizations/${org.organization.id}/invitations`,
      headers: { cookie: owner.cookie },
      payload: { email: 'New@Example.com', role: 'member' }
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ email: 'new@example.com', role: 'member', status: 'pending' });
    expect(ok.json()).not.toHaveProperty('token');
    expect(ok.json()).not.toHaveProperty('tokenHash');

    const outsider = await signup(app, 'x@example.com');
    const denied = await app.inject({
      method: 'POST',
      url: `/organizations/${org.organization.id}/invitations`,
      headers: { cookie: outsider.cookie },
      payload: { email: 'y@example.com', role: 'viewer' }
    });
    expect(denied.statusCode).toBe(403);
  });
});
