import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { NotificationList, NotificationPreferences, PushDevice, type Role } from '@meetops/contracts';
import { signEmailLinkToken } from '@meetops/notifications';
import { InMemoryNotifications } from '../src/modules/notifications/in-memory.repository.js';
import { selectNotificationsRepository } from '../src/modules/notifications/index.js';
import {
  SELF_NOTIFICATION_SUBJECTS,
  defineAbilityFor,
  orgSubject,
} from '../src/modules/organizations/domain/abilities.js';
import { MissingProductionDependencyError, type ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const SECRET = 's'.repeat(40);
const sub = (endpoint: string) => ({
  provider: 'webpush',
  platform: 'web',
  subscription: { endpoint, keys: { p256dh: 'B'.repeat(20), auth: 'a'.repeat(10) } },
});

describe('ADR-013 notification routes', () => {
  let app: App;
  let repo: InMemoryNotifications;
  beforeEach(async () => {
    repo = new InMemoryNotifications();
    app = await buildApp({ notifications: repo, emailLinkSecret: SECRET } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const meId = async (c: Client) => (await c.get('/auth/session')).json<{ user: { id: string } }>().user.id;
  async function join(owner: Client, orgId: string, email: string, role: Role) {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }
  const seed = (organizationId: string, userId: string, id: string) =>
    repo.add({
      id,
      organizationId,
      userId,
      type: 'task.assigned',
      subjectType: 'task',
      subjectId: '00000000-0000-4000-8000-0000000000f1',
      data: {},
      readAt: null,
      createdAt: `2026-10-27T00:00:0${id.slice(-1)}.000Z`,
    });

  it('lists only the caller feed and marks read', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const viewer = await join(owner, org, 'v@example.com', 'viewer');
    const ownerId = await meId(owner);
    const viewerId = await meId(viewer);
    seed(org, ownerId, '00000000-0000-4000-8000-000000000001');
    seed(org, viewerId, '00000000-0000-4000-8000-000000000002');
    seed(org, viewerId, '00000000-0000-4000-8000-000000000003');
    const list = await viewer.get(`/orgs/${org}/notifications?limit=1`);
    expect(list.statusCode).toBe(200);
    expect(Value.Check(NotificationList, list.json())).toBe(true);
    expect(list.json().items[0]).toEqual({
      id: '00000000-0000-4000-8000-000000000003',
      organizationId: org,
      kind: 'task.assigned',
      title: 'A task was assigned to you',
      taskId: '00000000-0000-4000-8000-0000000000f1',
      readAt: null,
      createdAt: '2026-10-27T00:00:03.000Z',
    });
    const next = await viewer.get(`/orgs/${org}/notifications?cursor=${list.json().nextCursor}`);
    expect(next.json().items.map((n: { id: string }) => n.id)).toEqual(['00000000-0000-4000-8000-000000000002']);
    // Another user's id is a no-op, not an error.
    expect((await viewer.post(`/orgs/${org}/notifications/00000000-0000-4000-8000-000000000001/read`)).json()).toEqual({ updated: 0 });
    expect((await viewer.post(`/orgs/${org}/notifications/00000000-0000-4000-8000-000000000002/read`)).json()).toEqual({ updated: 1 });
    expect((await viewer.post(`/orgs/${org}/notifications/read-all`)).json()).toEqual({ updated: 1 });
    expect((await owner.get(`/orgs/${org}/notifications?unreadOnly=true`)).json().items).toHaveLength(1);
  });

  it('hides other orgs and rejects unauthenticated or malformed requests', async () => {
    const a = await signupAndLogin(app, 'a@example.com');
    const b = await signupAndLogin(app, 'b@example.com');
    const orgA = await createOrg(a, 'A');
    await createOrg(b, 'B');
    expect((await b.get(`/orgs/${orgA}/notifications`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/orgs/${orgA}/notifications` })).statusCode).toBe(401);
    expect((await a.post(`/orgs/${orgA}/notifications/not-a-uuid/read`)).statusCode).toBe(400);
  });

  it('gets and updates preferences', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    expect((await owner.get(`/orgs/${org}/notification-preferences`)).json()).toEqual({ items: [] });
    const put = await owner.put(`/orgs/${org}/notification-preferences`, {
      items: [{ type: '*', channel: 'email', enabled: false }],
    });
    expect(put.statusCode).toBe(200);
    expect(Value.Check(NotificationPreferences, put.json())).toBe(true);
    expect((await owner.put(`/orgs/${org}/notification-preferences`, { items: [{ type: '*', channel: 'sms', enabled: true }] })).statusCode).toBe(400);
  });

  it('POST /me/push-devices (mobile PR #262): Expo tokens or allowlisted Web Push only, never echoed', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    await createOrg(owner, 'Acme');
    const ok = await owner.post('/me/push-devices', { provider: 'expo', token: 'ExponentPushToken[abcdefghijkl]', platform: 'ios', deviceName: 'iPhone' });
    expect(ok.statusCode).toBe(201);
    expect(Value.Check(PushDevice, ok.json())).toBe(true);
    expect(Object.keys(ok.json()).sort()).toEqual(['createdAt', 'id', 'platform']);
    expect(ok.body).not.toContain('Exponent');
    expect((await owner.post('/me/push-devices', { provider: 'expo', token: 'nope', platform: 'android' })).statusCode).toBe(400);
    expect((await owner.post('/me/push-devices', sub('https://fcm.googleapis.com/fcm/send/abc'))).statusCode).toBe(201);
    for (const bad of ['https://evil.example/x', 'https://169.254.169.254/x', 'https://fcm.googleapis.com:8443/x']) {
      const r = await owner.post('/me/push-devices', sub(bad));
      expect(r.statusCode, bad).toBe(400);
      expect(r.body).not.toContain(bad);
    }
    expect(repo.devices).toHaveLength(2);
    const id = ok.json<{ id: string }>().id;
    expect((await owner.delete(`/me/push-devices/${id}`)).statusCode).toBe(204);
    expect((await owner.delete(`/me/push-devices/${id}`)).statusCode).toBe(204);
    expect(repo.devices).toHaveLength(1);
  });

  it('DELETE only affects the caller devices', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const m = await join(owner, org, 'm@example.com', 'member');
    const id = (await owner.post('/me/push-devices', { provider: 'expo', token: 'ExpoPushToken[abcdefghijkl]', platform: 'android' })).json<{ id: string }>().id;
    expect((await m.delete(`/me/push-devices/${id}`)).statusCode).toBe(204);
    expect(repo.devices.map((d) => d.id)).toEqual([id]);
  });

  it('revokes devices on membership removal and on logout', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const m = await join(owner, org, 'm@example.com', 'member');
    const mId = await meId(m);
    expect((await m.post('/me/push-devices', sub('https://web.push.apple.com/abc'))).statusCode).toBe(201);
    expect((await owner.delete(`/orgs/${org}/members/${mId}`)).statusCode).toBeLessThan(300);
    expect(repo.devices.filter((d) => d.userId === mId)).toHaveLength(0);
    expect((await owner.post('/me/push-devices', sub('https://web.push.apple.com/own'))).statusCode).toBe(201);
    expect((await owner.post('/auth/logout')).statusCode).toBeLessThan(300);
    expect(repo.devices).toHaveLength(0);
  });

  it('unsubscribe: GET shows a confirm page without changing state, POST applies', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const userId = await meId(owner);
    const token = signEmailLinkToken(SECRET, { purpose: 'unsubscribe', userId, organizationId: org, category: 'task-assigned' }, { ttlSeconds: 600 });
    const get = await app.inject({ method: 'GET', url: `/notifications/unsubscribe?token=${token}` });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toContain('text/html');
    expect(get.body).toContain('<form method="post"');
    expect(await repo.getPreferences(org, userId)).toEqual([]);
    const post = await app.inject({ method: 'POST', url: `/notifications/unsubscribe?token=${token}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    expect(await repo.getPreferences(org, userId)).toEqual([{ type: 'task-assigned', channel: 'email', enabled: false }]);
    const forged = `${token.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect((await app.inject({ method: 'POST', url: `/notifications/unsubscribe?token=${forged}` })).statusCode).toBe(400);
  });

  it('refuses the in-memory repository outside development/test', () => {
    expect(() => selectNotificationsRepository({} as ModuleDeps, 'production')).toThrow(MissingProductionDependencyError);
  });
});

describe('CASL: notification subjects are self-only for every role', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
    for (const s of SELF_NOTIFICATION_SUBJECTS) {
      it(`${role} manages own ${s}, never another user's`, () => {
        const a = defineAbilityFor({ userId: 'me', organizationId: 'org-a', role });
        for (const act of ['create', 'read', 'update', 'delete'] as const) {
          expect(a.can(act, orgSubject(s, { organizationId: 'org-a', createdById: 'me' }))).toBe(true);
          expect(a.can(act, orgSubject(s, { organizationId: 'org-a', createdById: 'other' }))).toBe(false);
          expect(a.can(act, orgSubject(s, { organizationId: 'org-b', createdById: 'me' }))).toBe(false);
        }
      });
    }
  }
});
