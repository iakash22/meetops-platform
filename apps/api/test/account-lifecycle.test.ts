import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, Client, signupAndLogin, PASSWORD, SID, type App } from './helpers.js';
import { InlineAuthMailQueue } from '../src/modules/auth/application/auth-mail.handler.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';

describe('account lifecycle (P1-BE-2)', () => {
  let app: App;
  let queue: InlineAuthMailQueue;
  let audit: InMemoryAuditLog;
  beforeEach(async () => {
    queue = new InlineAuthMailQueue();
    audit = new InMemoryAuditLog();
    app = await buildApp({ mailQueue: queue, audit });
  });
  afterEach(() => app.close());

  it('signup with an existing email is the same 202, never CONFLICT', async () => {
    const c = new Client(app);
    const a = await c.post('/auth/signup', {
      name: 'A',
      email: 'same@example.com',
      password: PASSWORD,
    });
    const b = await c.post('/auth/signup', {
      name: 'B',
      email: 'same@example.com',
      password: PASSWORD,
    });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(b.body).toBe(a.body);
    expect(b.body).not.toMatch(/CONFLICT|exists/i);
  });

  it('D7: queued mail jobs carry ids only (no emails, tokens or links)', async () => {
    const c = await signupAndLogin(app, 'ids@example.com');
    await c.post('/auth/forgot-password', { email: 'ids@example.com' });
    await c.post('/auth/forgot-password', { email: 'ghost@example.com' });
    const org = (await c.post('/orgs', { name: 'Ids' })).json();
    await c.post(`/orgs/${org.organization.id}/invitations`, {
      email: 'x@example.com',
      role: 'member',
    });
    const raw = JSON.stringify(queue.jobs);
    expect(raw).not.toMatch(/@|http|token"/);
    expect(queue.jobs.map((j) => j.kind)).toEqual([
      'email_verification',
      'password_reset',
      'password_reset',
      'invitation',
    ]);
  });

  it('D5: forgot-password enqueues exactly one job on both known and unknown paths', async () => {
    await signupAndLogin(app, 'known@example.com');
    const anon = new Client(app);
    const before = queue.jobs.length;
    const k = await anon.post('/auth/forgot-password', { email: 'known@example.com' });
    const mid = queue.jobs.length;
    const u = await anon.post('/auth/forgot-password', { email: 'unknown@example.com' });
    expect([mid - before, queue.jobs.length - mid]).toEqual([1, 1]);
    expect(u.body).toBe(k.body);
    expect(app.mail.sent.filter((m) => m.template === 'password_reset').map((m) => m.to)).toEqual([
      'known@example.com',
    ]);
  });

  it('D2: verify-email gate on org create and invite accept; verification is single-use', async () => {
    const c = await signupAndLogin(app, 'nv@example.com', PASSWORD, { verify: false });
    const create = await c.post('/orgs', { name: 'NV' });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('FORBIDDEN');

    const owner = await signupAndLogin(app, 'boss@example.com');
    const org = (await owner.post('/orgs', { name: 'Gate' })).json();
    await owner.post(`/orgs/${org.organization.id}/invitations`, {
      email: 'nv@example.com',
      role: 'member',
    });
    const invToken = app.token('nv@example.com', 'invitation')!;
    expect((await c.post('/invitations/accept', { token: invToken })).statusCode).toBe(403);

    const token = app.token('nv@example.com', 'email_verification')!;
    expect((await c.post('/auth/verify-email', { token })).statusCode).toBe(204);
    expect((await c.post('/auth/verify-email', { token })).statusCode).toBe(400);
    expect((await c.post('/invitations/accept', { token: invToken })).statusCode).toBe(200);
    expect((await c.post('/orgs', { name: 'NV' })).statusCode).toBe(201);
  });

  it('resend-verification is enumeration-safe and replaces the old link', async () => {
    const c = await signupAndLogin(app, 'rs@example.com', PASSWORD, { verify: false });
    const first = app.token('rs@example.com', 'email_verification')!;
    const anon = new Client(app);
    const a = await anon.post('/auth/resend-verification', { email: 'rs@example.com' });
    const b = await anon.post('/auth/resend-verification', { email: 'nobody@example.com' });
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(b.body).toBe(a.body);
    const second = app.token('rs@example.com', 'email_verification')!;
    expect(second).not.toBe(first);
    expect((await c.post('/auth/verify-email', { token: first })).statusCode).toBe(400);
    expect((await c.post('/auth/verify-email', { token: second })).statusCode).toBe(204);
  });

  it('D3: list sessions, revoke one by id (own only), logout-all', async () => {
    const a1 = await signupAndLogin(app, 'multi@example.com');
    const a2 = new Client(app);
    await a2.post('/auth/login', { email: 'multi@example.com', password: PASSWORD });
    const list = (await a1.get('/auth/sessions')).json();
    expect(list.items).toHaveLength(2);
    expect(list.items.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/hash|token/i);
    const other = list.items.find((s: { current: boolean }) => !s.current).id as string;

    const stranger = await signupAndLogin(app, 'stranger@example.com');
    expect((await stranger.delete(`/auth/sessions/${other}`)).statusCode).toBe(404);
    expect((await stranger.delete(`/auth/sessions/${randomUUID()}`)).statusCode).toBe(404);

    expect((await a1.delete(`/auth/sessions/${other}`)).statusCode).toBe(204);
    expect((await a2.get('/auth/session')).statusCode).toBe(401);
    expect((await a1.get('/auth/session')).statusCode).toBe(200);

    const a3 = new Client(app);
    await a3.post('/auth/login', { email: 'multi@example.com', password: PASSWORD });
    expect((await a1.post('/auth/logout-all')).statusCode).toBe(204);
    expect((await a1.get('/auth/session')).statusCode).toBe(401);
    expect((await a3.get('/auth/session')).statusCode).toBe(401);
  });

  it('D3: security events are audited without secrets', async () => {
    const c = await signupAndLogin(app, 'aud@example.com');
    await new Client(app).post('/auth/login', {
      email: 'aud@example.com',
      password: 'wrong-password-123',
    });
    await c.post('/orgs', { name: 'Aud' });
    await c.post('/auth/logout');
    const actions = audit.events.map((e) => e.action);
    for (const a of [
      'auth.signup',
      'auth.email.verify',
      'auth.login.success',
      'auth.login.failure',
      'org.create',
      'auth.logout',
    ]) {
      expect(actions).toContain(a);
    }
    expect(JSON.stringify(audit.events)).not.toMatch(/wrong-password|correct-horse|fake\$/);
  });

  describe('D8: role change and member removal (AU-29..31, AU-33)', () => {
    const team = async () => {
      const owner = await signupAndLogin(app, 'own@example.com');
      const org = (await owner.post('/orgs', { name: 'Team' })).json();
      const id = org.organization.id as string;
      const join = async (email: string, role: string) => {
        const c = await signupAndLogin(app, email);
        await owner.post(`/orgs/${id}/invitations`, { email, role });
        const r = await c.post('/invitations/accept', { token: app.token(email, 'invitation')! });
        if (r.statusCode !== 200) throw new Error(r.body);
        return { c, userId: (await c.get('/auth/session')).json().user.id as string };
      };
      const ownerId = (await owner.get('/auth/session')).json().user.id as string;
      return {
        id,
        owner,
        ownerId,
        member: await join('mem@example.com', 'member'),
        admin: await join('adm@example.com', 'admin'),
      };
    };

    it('AU-29 member cannot promote self (403); AU-33 unknown role is 400', async () => {
      const t = await team();
      expect(
        (await t.member.c.patch(`/orgs/${t.id}/members/${t.member.userId}`, { role: 'admin' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await t.owner.patch(`/orgs/${t.id}/members/${t.member.userId}`, { role: 'guest' }))
          .statusCode,
      ).toBe(400);
    });

    it('AU-30 admin cannot demote or remove the owner (403)', async () => {
      const t = await team();
      expect(
        (await t.admin.c.patch(`/orgs/${t.id}/members/${t.ownerId}`, { role: 'member' }))
          .statusCode,
      ).toBe(403);
      expect((await t.admin.c.delete(`/orgs/${t.id}/members/${t.ownerId}`)).statusCode).toBe(403);
    });

    it('AU-31 last owner cannot demote self or leave (409 CONFLICT, reason LAST_OWNER)', async () => {
      const t = await team();
      const r = await t.owner.patch(`/orgs/${t.id}/members/${t.ownerId}`, { role: 'admin' });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatchObject({ code: 'CONFLICT', reason: 'LAST_OWNER' });
      const d = await t.owner.delete(`/orgs/${t.id}/members/${t.ownerId}`);
      expect(d.statusCode).toBe(409);
      expect(d.json().error).toMatchObject({ code: 'CONFLICT', reason: 'LAST_OWNER' });
    });

    it('owner changes a role / removes a member; target sessions are revoked', async () => {
      const t = await team();
      const r = await t.owner.patch(`/orgs/${t.id}/members/${t.member.userId}`, { role: 'viewer' });
      expect(r.statusCode).toBe(200);
      expect(r.json().role).toBe('viewer');
      expect((await t.member.c.get('/auth/session')).statusCode).toBe(401);
      expect((await t.owner.delete(`/orgs/${t.id}/members/${t.admin.userId}`)).statusCode).toBe(
        204,
      );
      expect((await t.admin.c.get('/auth/session')).statusCode).toBe(401);
      const list = (await t.owner.get(`/orgs/${t.id}/members`)).json();
      expect(
        list.items.map((m: { userId: string; role: string }) => [m.userId, m.role]).sort(),
      ).toEqual(
        [
          [t.ownerId, 'owner'],
          [t.member.userId, 'viewer'],
        ].sort(),
      );
      expect(t.owner.jar.get(SID)).toBeTruthy();
    });

    it('non-members get 404 on member routes', async () => {
      const t = await team();
      const outsider = await signupAndLogin(app, 'out@example.com');
      expect((await outsider.get(`/orgs/${t.id}/members`)).statusCode).toBe(404);
      expect(
        (await outsider.patch(`/orgs/${t.id}/members/${t.member.userId}`, { role: 'viewer' }))
          .statusCode,
      ).toBe(404);
    });
  });
});
