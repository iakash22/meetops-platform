/* eslint-disable @typescript-eslint/no-unsafe-argument -- test/ is not part of a TS project (see report) */
import { describe, it, expect, beforeEach } from 'vitest';
import { defineAbilityFor, orgSubject } from '../src/modules/organizations/domain/abilities';
import { canGrantRole, type Role } from '../src/modules/organizations/domain/membership';
import { acceptInvitation, revokeInvitation, type Invitation } from '../src/modules/organizations/domain/invitation';
import { OrganizationService } from '../src/modules/organizations/application/organization.service';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository
} from '../src/modules/organizations/infrastructure/in-memory.repositories';
import { CryptoTokenService } from '../src/modules/auth/infrastructure/crypto-token.service';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory';
import { RedisRateLimiter, RedisLoginLockout, type RedisLike } from '../src/modules/auth/infrastructure/rate-limit/redis';

const A = 'org-a';
const B = 'org-b';
const ab = (role: Role | null, organizationId: string | null = A) => defineAbilityFor({ userId: 'u', organizationId, role });
const s = (t: Parameters<typeof orgSubject>[0], organizationId = A, createdById?: string) =>
  orgSubject(t, createdById ? { organizationId, createdById } : { organizationId });

describe('CASL abilities (rbac-matrix)', () => {
  it('owner manages everything in its org only', () => {
    expect(ab('owner').can('delete', s('Organization'))).toBe(true);
    expect(ab('owner').can('read', s('Organization', B))).toBe(false);
  });
  it('admin manages invites but cannot delete the org', () => {
    expect(ab('admin').can('create', s('Invitation'))).toBe(true);
    expect(ab('admin').can('update', s('Organization'))).toBe(true);
    expect(ab('admin').can('delete', s('Organization'))).toBe(false);
    expect(ab('admin').can('create', s('Invitation', B))).toBe(false);
  });
  it('member reads, creates meetings, edits only own meetings, cannot invite', () => {
    const m = ab('member');
    expect(m.can('read', s('Organization'))).toBe(true);
    expect(m.can('create', s('Meeting'))).toBe(true);
    expect(m.can('update', s('Meeting', A, 'u'))).toBe(true);
    expect(m.can('update', s('Meeting', A, 'other'))).toBe(false);
    expect(m.can('create', s('Invitation'))).toBe(false);
  });
  it('viewer is read-only; no membership means nothing but creating an org', () => {
    expect(ab('viewer').can('read', s('Meeting'))).toBe(true);
    expect(ab('viewer').can('create', s('Meeting'))).toBe(false);
    expect(ab(null).can('read', s('Organization'))).toBe(false);
    expect(ab(null, null).can('create', 'Organization')).toBe(true);
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
  organizationId: A,
  email: 'a@example.com',
  role: 'member',
  tokenHash: 'h',
  invitedById: 'u0',
  status: 'pending',
  expiresAt: new Date(now.getTime() + 1000),
  createdAt: now,
  acceptedAt: null,
  acceptedById: null,
  revokedAt: null,
  deletedAt: null
};

describe('invitation rules', () => {
  it('accepts a pending invitation for the matching email', () => {
    expect(acceptInvitation(base, { userId: 'u1', email: 'a@example.com' }, now)).toMatchObject({ status: 'accepted', acceptedById: 'u1' });
  });
  it('rejects expired, revoked, accepted and wrong-email invitations', () => {
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

describe('OrganizationService', () => {
  let svc: OrganizationService;
  let clockNow: Date;
  let n = 0;
  beforeEach(() => {
    clockNow = now;
    n = 0;
    const clock = { now: () => clockNow };
    svc = new OrganizationService({
      organizations: new InMemoryOrganizationRepository(),
      memberships: new InMemoryMembershipRepository(),
      invitations: new InMemoryInvitationRepository(),
      tokens: new CryptoTokenService(),
      rateLimiter: new InMemoryRateLimiter(clock),
      clock,
      ids: { next: () => `id-${++n}-xxxxxxxx` },
      invitationTtlMs: 60_000
    });
  });

  const setup = async () => {
    const { organization } = await svc.create({ name: 'Acme', userId: 'owner' });
    const ctx = await svc.resolveTenant(organization.id, 'owner');
    return { organization, ctx };
  };

  it('invite → accept creates a membership; token is stored only hashed and single-use', async () => {
    const { ctx } = await setup();
    const { token, invitation } = await svc.invite(ctx, { email: 'A@Example.com', role: 'viewer' });
    expect(invitation.tokenHash).not.toBe(token);
    const r = await svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null });
    expect(r.membership.role).toBe('viewer');
    await expect(svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/already accepted/);
  });

  it('re-inviting the same address revokes the previous pending invite', async () => {
    const { ctx } = await setup();
    const first = await svc.invite(ctx, { email: 'a@example.com', role: 'viewer' });
    await svc.invite(ctx, { email: 'a@example.com', role: 'member' });
    await expect(svc.acceptInvitation({ token: first.token, userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/revoked/);
  });

  it('rejects expired invitations and unknown tokens', async () => {
    const { ctx } = await setup();
    const { token } = await svc.invite(ctx, { email: 'a@example.com', role: 'member' });
    clockNow = new Date(now.getTime() + 60_001);
    await expect(svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/expired/);
    await expect(svc.acceptInvitation({ token: 'unknown', userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/not found/);
  });

  it('members cannot invite/revoke; admins cannot grant admin', async () => {
    const { organization, ctx } = await setup();
    const join = async (email: string, role: 'member' | 'admin', userId: string) => {
      const { token } = await svc.invite(ctx, { email, role });
      await svc.acceptInvitation({ token, userId, email, ip: null });
      return svc.resolveTenant(organization.id, userId);
    };
    const member = await join('m@example.com', 'member', 'member');
    const admin = await join('ad@example.com', 'admin', 'admin');
    await expect(svc.invite(member, { email: 'z@example.com', role: 'viewer' })).rejects.toThrow(/permission/);
    await expect(svc.invite(admin, { email: 'z@example.com', role: 'admin' })).rejects.toThrow(/permission/);
    const pending = await svc.invite(admin, { email: 'p@example.com', role: 'member' });
    await expect(svc.revokeInvitation(member, pending.invitation.id)).rejects.toThrow(/permission/);
    expect((await svc.revokeInvitation(admin, pending.invitation.id)).status).toBe('revoked');
  });

  it('rate-limits invites to 5/day per address', async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 5; i++) await svc.invite(ctx, { email: 'spam@example.com', role: 'viewer' });
    await expect(svc.invite(ctx, { email: 'spam@example.com', role: 'viewer' })).rejects.toThrow(/Too many/);
  });

  it('resolveTenant 404s for non-members', async () => {
    const { organization } = await setup();
    await expect(svc.resolveTenant(organization.id, 'stranger')).rejects.toThrow(/not found/);
  });
});

describe('Redis rate-limit adapters (fake client)', () => {
  const fakeRedis = (): RedisLike => {
    const store = new Map<string, { v: number; exp: number }>();
    let t = 0;
    return {
      incr: async (k) => {
        const e = store.get(k) ?? { v: 0, exp: Infinity };
        e.v++;
        store.set(k, e);
        return e.v;
      },
      pexpire: async (k, ms) => {
        const e = store.get(k);
        if (e) e.exp = t + ms;
        return 1;
      },
      pttl: async (k) => {
        const e = store.get(k);
        return e ? (e.exp === Infinity ? -1 : e.exp - t) : -2;
      },
      set: async (k, _v, _m, ms) => {
        store.set(k, { v: 1, exp: t + ms });
        t += 0;
        return 'OK';
      },
      del: async (k) => (store.delete(k) ? 1 : 0)
    };
  };
  it('RedisRateLimiter blocks after the limit', async () => {
    const rl = new RedisRateLimiter(fakeRedis());
    for (let i = 0; i < 3; i++) expect((await rl.consume('k', 3, 1000)).allowed).toBe(true);
    const r = await rl.consume('k', 3, 1000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });
  it('RedisLoginLockout locks after maxFailures', async () => {
    const lo = new RedisLoginLockout(fakeRedis(), { maxFailures: 2, windowMs: 1000, lockMs: 5000 });
    await lo.recordFailure('a');
    expect((await lo.isLocked('a')).locked).toBe(false);
    await lo.recordFailure('a');
    expect((await lo.isLocked('a')).locked).toBe(true);
  });
});

describe('SessionVerifier', () => {
  it('resolves a cookie token to user, organizationId and role', async () => {
    const { buildApp, signupAndLogin, SID } = await import('./helpers');
    const { defaultModuleDeps } = await import('../src/modules/index');
    const { AuthService } = await import('../src/modules/auth/application/auth.service');
    const { SessionVerifier } = await import('../src/modules/auth/application/session-verifier');
    const deps = defaultModuleDeps();
    const app = await buildApp(deps);
    const c = await signupAndLogin(app, 'rt@example.com');
    const org = (await c.post('/orgs', { name: 'RT' })).json();
    const v = new SessionVerifier(new AuthService({ ...deps, hasher: deps.hasher }), deps.memberships);
    const r = await v.verify(c.jar.get(SID));
    expect(r).toMatchObject({ organizationId: org.organization.id, role: 'owner', user: { email: 'rt@example.com' } });
    await expect(v.verify('bogus')).rejects.toThrow();
    expect(await v.canAccessMeeting(r, 'm1')).toBe(false);
    await app.close();
  });
});
