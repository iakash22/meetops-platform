import { describe, it, expect, beforeEach } from 'vitest';
import { defineAbilityFor } from '../src/modules/organizations/domain/abilities';
import { canGrantRole } from '../src/modules/organizations/domain/membership';
import { acceptInvitation, revokeInvitation, type Invitation } from '../src/modules/organizations/domain/invitation';
import { OrganizationService } from '../src/modules/organizations/application/organization.service';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository
} from '../src/modules/organizations/infrastructure/in-memory.repositories';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository';
import { CryptoTokenService } from '../src/modules/auth/infrastructure/crypto-token.service';

describe('CASL abilities', () => {
  it('owner can manage everything', () => {
    const a = defineAbilityFor('owner');
    expect(a.can('delete', 'Organization')).toBe(true);
    expect(a.can('invite', 'Invitation')).toBe(true);
  });
  it('admin can invite but cannot delete the organization', () => {
    const a = defineAbilityFor('admin');
    expect(a.can('invite', 'Invitation')).toBe(true);
    expect(a.can('update', 'Organization')).toBe(true);
    expect(a.can('delete', 'Organization')).toBe(false);
  });
  it('member can read and create meetings but not invite', () => {
    const a = defineAbilityFor('member');
    expect(a.can('read', 'Organization')).toBe(true);
    expect(a.can('create', 'Meeting')).toBe(true);
    expect(a.can('invite', 'Invitation')).toBe(false);
    expect(a.can('update', 'Organization')).toBe(false);
  });
  it('viewer is read-only', () => {
    const a = defineAbilityFor('viewer');
    expect(a.can('read', 'Meeting')).toBe(true);
    expect(a.can('create', 'Meeting')).toBe(false);
  });
  it('no role means no abilities', () => {
    expect(defineAbilityFor(null).can('read', 'Organization')).toBe(false);
  });
  it('role granting rules', () => {
    expect(canGrantRole('owner', 'admin')).toBe(true);
    expect(canGrantRole('admin', 'admin')).toBe(false);
    expect(canGrantRole('admin', 'member')).toBe(true);
    expect(canGrantRole('owner', 'owner')).toBe(false);
    expect(canGrantRole('member', 'viewer')).toBe(false);
  });
});

const now = new Date('2026-06-01T00:00:00Z');
const base: Invitation = {
  id: 'i1',
  organizationId: 'o1',
  email: 'a@example.com',
  role: 'member',
  tokenHash: 'h',
  invitedById: 'u0',
  status: 'pending',
  expiresAt: new Date(now.getTime() + 1000),
  createdAt: now,
  acceptedAt: null,
  acceptedById: null,
  revokedAt: null
};

describe('invitation rules', () => {
  it('accepts a pending invitation for the matching email', () => {
    const r = acceptInvitation(base, { userId: 'u1', email: 'a@example.com' }, now);
    expect(r).toMatchObject({ status: 'accepted', acceptedById: 'u1', acceptedAt: now });
  });
  it('rejects expired, revoked, already accepted and wrong-email invitations', () => {
    const by = { userId: 'u1', email: 'a@example.com' };
    expect(() => acceptInvitation(base, by, new Date(now.getTime() + 1000))).toThrow(/expired/);
    expect(() => acceptInvitation({ ...base, status: 'revoked' }, by, now)).toThrow(/revoked/);
    expect(() => acceptInvitation({ ...base, status: 'accepted' }, by, now)).toThrow(/already accepted/);
    expect(() => acceptInvitation(base, { userId: 'u1', email: 'b@example.com' }, now)).toThrow(/different email/);
  });
  it('revokes only pending invitations', () => {
    expect(revokeInvitation(base, now)).toMatchObject({ status: 'revoked', revokedAt: now });
    expect(() => revokeInvitation({ ...base, status: 'accepted' }, now)).toThrow();
    expect(() => revokeInvitation({ ...base, status: 'revoked' }, now)).toThrow();
  });
});

describe('OrganizationService invitations', () => {
  let svc: OrganizationService;
  let clockNow: Date;
  let n = 0;
  beforeEach(() => {
    clockNow = now;
    n = 0;
    svc = new OrganizationService({
      organizations: new InMemoryOrganizationRepository(),
      memberships: new InMemoryMembershipRepository(),
      invitations: new InMemoryInvitationRepository(),
      sessions: new InMemorySessionRepository(),
      tokens: new CryptoTokenService(),
      clock: { now: () => clockNow },
      ids: { next: () => `id-${++n}-xxxxxxxx` },
      invitationTtlMs: 60_000
    });
  });

  it('invite -> accept creates membership with the invited role', async () => {
    const { organization } = await svc.create({ name: 'Acme', userId: 'owner', sessionId: 's' });
    const { token, invitation } = await svc.invite({
      organizationId: organization.id,
      actorUserId: 'owner',
      email: 'A@Example.com',
      role: 'viewer'
    });
    expect(invitation.tokenHash).not.toBe(token);
    const r = await svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com' });
    expect(r.membership.role).toBe('viewer');
    await expect(svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com' })).rejects.toThrow(
      /already accepted/
    );
  });

  it('rejects expired invitations and unknown tokens', async () => {
    const { organization } = await svc.create({ name: 'Acme', userId: 'owner', sessionId: 's' });
    const { token } = await svc.invite({ organizationId: organization.id, actorUserId: 'owner', email: 'a@example.com', role: 'member' });
    clockNow = new Date(now.getTime() + 60_001);
    await expect(svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com' })).rejects.toThrow(/expired/);
    await expect(svc.acceptInvitation({ token: 'unknown', userId: 'u2', email: 'a@example.com' })).rejects.toThrow(
      /not found/
    );
  });

  it('members cannot invite or revoke; admins cannot grant admin; revoked invites cannot be accepted', async () => {
    const { organization } = await svc.create({ name: 'Acme', userId: 'owner', sessionId: 's' });
    const orgId = organization.id;
    const m = await svc.invite({ organizationId: orgId, actorUserId: 'owner', email: 'm@example.com', role: 'member' });
    await svc.acceptInvitation({ token: m.token, userId: 'member', email: 'm@example.com' });
    const a = await svc.invite({ organizationId: orgId, actorUserId: 'owner', email: 'ad@example.com', role: 'admin' });
    await svc.acceptInvitation({ token: a.token, userId: 'admin', email: 'ad@example.com' });

    await expect(
      svc.invite({ organizationId: orgId, actorUserId: 'member', email: 'z@example.com', role: 'viewer' })
    ).rejects.toThrow(/permission/);
    await expect(
      svc.invite({ organizationId: orgId, actorUserId: 'admin', email: 'z@example.com', role: 'admin' })
    ).rejects.toThrow(/permission/);

    const pending = await svc.invite({ organizationId: orgId, actorUserId: 'admin', email: 'p@example.com', role: 'member' });
    await expect(svc.revokeInvitation({ invitationId: pending.invitation.id, actorUserId: 'member' })).rejects.toThrow(
      /permission/
    );
    const revoked = await svc.revokeInvitation({ invitationId: pending.invitation.id, actorUserId: 'admin' });
    expect(revoked.status).toBe('revoked');
    await expect(svc.acceptInvitation({ token: pending.token, userId: 'p', email: 'p@example.com' })).rejects.toThrow(
      /revoked/
    );
  });
});
