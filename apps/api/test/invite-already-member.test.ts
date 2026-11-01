import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, signupAndLogin, Client, PASSWORD, type App } from './helpers.js';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
} from '../src/modules/organizations/infrastructure/in-memory.repositories.js';
import type { Invitation } from '../src/modules/organizations/domain/invitation.js';

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

describe('invitations vs active members (409 already_member)', () => {
  let app: App;
  let memberships: InMemoryMembershipRepository;
  let invitations: InMemoryInvitationRepository;
  beforeEach(async () => {
    memberships = new InMemoryMembershipRepository();
    invitations = new InMemoryInvitationRepository(memberships);
    app = await buildApp({ memberships, invitations });
  });
  afterEach(async () => app.close());

  const userId = async (c: Client) => (await c.get('/auth/session')).json().user.id as string;
  const inviteToken = (email: string) => app.token(email, 'invitation')!;

  /** owner + admin in one org. */
  const setup = async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const id = (await owner.post('/orgs', { name: 'Acme' })).json().organization.id as string;
    expect(
      (await owner.post(`/orgs/${id}/invitations`, { email: 'admin@example.com', role: 'admin' }))
        .statusCode,
    ).toBe(201);
    const admin = await signupAndLogin(app, 'admin@example.com');
    expect(
      (await admin.post('/invitations/accept', { token: inviteToken('admin@example.com') }))
        .statusCode,
    ).toBe(200);
    return { owner, admin, id };
  };

  /** A pending invitation that predates the membership (e.g. created before the user joined another way). */
  const plantInvite = async (
    organizationId: string,
    email: string,
    role: Invitation['role'],
    invitedById: string,
  ) => {
    const token = randomUUID() + randomUUID();
    const now = new Date();
    await invitations.create(organizationId, {
      id: randomUUID(),
      organizationId,
      email,
      role,
      tokenHash: sha256(token),
      invitedById,
      status: 'pending',
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: now,
      acceptedAt: null,
      acceptedById: null,
      revokedAt: null,
      deletedAt: null,
    });
    return token;
  };

  it('invite: refuses an active member with a 409 CONFLICT envelope, sends no mail and creates no invite', async () => {
    const { owner, id } = await setup();
    const mailsBefore = app.mail.sent.length;
    const res = await owner.post(`/orgs/${id}/invitations`, {
      email: 'Admin@Example.com',
      role: 'viewer',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: {
        code: 'CONFLICT',
        reason: 'ALREADY_MEMBER',
        message: 'This person is already a member of the organization',
        requestId: expect.any(String),
      },
    });
    expect(app.mail.sent.length).toBe(mailsBefore);
    expect(await invitations.findPendingByEmail(id, 'admin@example.com')).toBeNull();
    // Admin keeps the admin role.
    const members = (await owner.get(`/orgs/${id}/members`)).json().items as {
      userId: string;
      role: string;
    }[];
    expect(members.map((m) => m.role).sort()).toEqual(['admin', 'owner']);
  });

  it('admin cannot demote the owner by inviting the owner (409, owner role unchanged)', async () => {
    const { owner, admin, id } = await setup();
    for (const role of ['viewer', 'member'] as const) {
      const res = await admin.post(`/orgs/${id}/invitations`, { email: 'owner@example.com', role });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CONFLICT');
    }
    expect((await owner.get('/auth/session')).json().role).toBe('owner');
  });

  it('admin cannot demote the owner through accept: a stale invite for the owner returns 409 and changes nothing', async () => {
    const { owner, admin, id } = await setup();
    const token = await plantInvite(id, 'owner@example.com', 'viewer', await userId(admin));
    const res = await owner.post('/invitations/accept', { token });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: {
        code: 'CONFLICT',
        reason: 'ALREADY_MEMBER',
        message: 'This person is already a member of the organization',
        requestId: expect.any(String),
      },
    });
    expect((await owner.get('/auth/session')).json().role).toBe('owner');
    const members = (await owner.get(`/orgs/${id}/members`)).json().items as { role: string }[];
    expect(members.map((m) => m.role).sort()).toEqual(['admin', 'owner']);
    // Invitation is not consumed (matches Postgres accept_invitation): still pending and revocable.
    const pending = await invitations.findPendingByEmail(id, 'owner@example.com');
    expect(pending?.status).toBe('pending');
    expect((await admin.post(`/orgs/${id}/invitations/${pending!.id}/revoke`)).statusCode).toBe(
      200,
    );
  });

  it('accept: an invalid token is still the generic 404, not 409', async () => {
    const { owner } = await setup();
    const res = await owner.post('/invitations/accept', { token: 'x'.repeat(48) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('a removed (soft-deleted) member can be invited again and rejoins with the invited role', async () => {
    const { owner, id } = await setup();
    expect(
      (await owner.post(`/orgs/${id}/invitations`, { email: 'm@example.com', role: 'member' }))
        .statusCode,
    ).toBe(201);
    const m = await signupAndLogin(app, 'm@example.com');
    expect(
      (await m.post('/invitations/accept', { token: inviteToken('m@example.com') })).statusCode,
    ).toBe(200);
    expect((await owner.delete(`/orgs/${id}/members/${await userId(m)}`)).statusCode).toBeLessThan(
      300,
    );
    expect(
      (await owner.post(`/orgs/${id}/invitations`, { email: 'm@example.com', role: 'viewer' }))
        .statusCode,
    ).toBe(201);
    const m2 = new Client(app);
    expect(
      (await m2.post('/auth/login', { email: 'm@example.com', password: PASSWORD })).statusCode,
    ).toBe(200);
    const acc = await m2.post('/invitations/accept', { token: inviteToken('m@example.com') });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().role).toBe('viewer');
  });
});
