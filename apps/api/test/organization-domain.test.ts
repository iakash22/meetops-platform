import { describe, it, expect, beforeEach } from 'vitest';
import { defineAbilityFor, orgSubject } from '../src/modules/organizations/domain/abilities.js';
import { canGrantRole, type Role } from '../src/modules/organizations/domain/membership.js';
import { acceptInvitation, revokeInvitation, type Invitation } from '../src/modules/organizations/domain/invitation.js';
import { OrganizationService } from '../src/modules/organizations/application/organization.service.js';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository
} from '../src/modules/organizations/infrastructure/in-memory.repositories.js';
import { CryptoTokenService } from '../src/modules/auth/infrastructure/crypto-token.service.js';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import { RedisRateLimiter, RedisLoginLockout, type RedisLike } from '../src/modules/auth/infrastructure/rate-limit/redis.js';
import { InMemoryLoginLockout } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import { lockDurationMs } from '../src/modules/auth/infrastructure/rate-limit/lockout-policy.js';
import { RedisOneTimeTokenRepository } from '../src/modules/auth/infrastructure/redis-one-time-token.repository.js';
import { InMemoryOneTimeTokenRepository } from '../src/modules/auth/infrastructure/in-memory-one-time-token.repository.js';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import { InMemoryUserRepository } from '../src/modules/users/infrastructure/in-memory-user.repository.js';
import { RecordingMailTransport } from '../src/modules/auth/domain/mail-jobs.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { AuthMailJobHandler, InlineAuthMailQueue } from '../src/modules/auth/application/auth-mail.handler.js';
import { randomUUID } from 'node:crypto';

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
  let mail: RecordingMailTransport;
  let users: InMemoryUserRepository;
  let sessions: InMemorySessionRepository;
  let clockNow: Date;
  beforeEach(() => {
    clockNow = now;
    const clock = { now: () => clockNow };
    const memberships = new InMemoryMembershipRepository();
    const organizations = new InMemoryOrganizationRepository();
    const invitations = new InMemoryInvitationRepository(memberships);
    const tokens = new CryptoTokenService();
    users = new InMemoryUserRepository();
    sessions = new InMemorySessionRepository();
    mail = new RecordingMailTransport();
    const mailQueue = new InlineAuthMailQueue();
    mailQueue.handler = new AuthMailJobHandler({
      users,
      oneTimeTokens: new InMemoryOneTimeTokenRepository(),
      organizations,
      invitations,
      tokens,
      transport: mail,
      clock,
      webBaseUrl: 'http://web.test'
    });
    svc = new OrganizationService({
      organizations,
      memberships,
      invitations,
      users,
      sessions,
      mailQueue,
      audit: new InMemoryAuditLog(),
      tokens,
      rateLimiter: new InMemoryRateLimiter(clock),
      clock,
      ids: { next: () => randomUUID() },
      invitationTtlMs: 60_000
    });
  });

  const addUser = async (id: string, email: string, verified = true) => {
    await users.create({ id, email, name: null, passwordHash: 'x', emailVerifiedAt: verified ? now : null, createdAt: now, updatedAt: now, deletedAt: null });
  };
  const setup = async () => {
    await addUser('owner', 'owner@example.com');
    const { organization } = await svc.create({ name: 'Acme', userId: 'owner' });
    const ctx = await svc.resolveTenant(organization.id, 'owner');
    return { organization, ctx };
  };
  const tokenFor = (email: string) => mail.lastToken(email, 'invitation')!;

  it('invite mails an opaque token (no org id) stored only hashed; accept is single-use', async () => {
    const { ctx, organization } = await setup();
    await addUser('u2', 'a@example.com');
    const { invitation } = await svc.invite(ctx, { email: 'A@Example.com', role: 'viewer' });
    const token = tokenFor('a@example.com');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain(organization.id);
    expect(invitation).not.toHaveProperty('token');
    const r = await svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null });
    expect(r.membership.role).toBe('viewer');
    await expect(svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/not found/);
  });

  it('concurrent accepts: exactly one wins', async () => {
    const { ctx } = await setup();
    await addUser('u2', 'a@example.com');
    await svc.invite(ctx, { email: 'a@example.com', role: 'member' });
    const token = tokenFor('a@example.com');
    const rs = await Promise.allSettled([1, 2, 3].map(() => svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('re-inviting the same address revokes the previous pending invite', async () => {
    const { ctx } = await setup();
    await addUser('u2', 'a@example.com');
    await svc.invite(ctx, { email: 'a@example.com', role: 'viewer' });
    const first = tokenFor('a@example.com');
    await svc.invite(ctx, { email: 'a@example.com', role: 'member' });
    await expect(svc.acceptInvitation({ token: first, userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/not found/);
  });

  it('rejects expired invitations, wrong email and unknown tokens', async () => {
    const { ctx } = await setup();
    await addUser('u2', 'a@example.com');
    await addUser('u3', 'b@example.com');
    await svc.invite(ctx, { email: 'a@example.com', role: 'member' });
    const token = tokenFor('a@example.com');
    await expect(svc.acceptInvitation({ token, userId: 'u3', email: 'b@example.com', ip: null })).rejects.toThrow(/not found/);
    clockNow = new Date(now.getTime() + 60_001);
    await expect(svc.acceptInvitation({ token, userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/not found/);
    await expect(svc.acceptInvitation({ token: 'unknown', userId: 'u2', email: 'a@example.com', ip: null })).rejects.toThrow(/not found/);
  });

  it('D2: unverified users cannot create orgs, invite or accept', async () => {
    const { ctx } = await setup();
    await addUser('nv', 'nv@example.com', false);
    await expect(svc.create({ name: 'X', userId: 'nv' })).rejects.toThrow(/Verify your email/);
    await svc.invite(ctx, { email: 'nv@example.com', role: 'member' });
    await expect(svc.acceptInvitation({ token: tokenFor('nv@example.com'), userId: 'nv', email: 'nv@example.com', ip: null })).rejects.toThrow(
      /Verify your email/
    );
  });

  const team = async () => {
    const { organization, ctx } = await setup();
    const join = async (email: string, role: 'member' | 'admin' | 'viewer', userId: string) => {
      await addUser(userId, email);
      await svc.invite(ctx, { email, role });
      await svc.acceptInvitation({ token: tokenFor(email), userId, email, ip: null });
      return svc.resolveTenant(organization.id, userId);
    };
    return { organization, owner: ctx, member: await join('m@example.com', 'member', 'member'), admin: await join('ad@example.com', 'admin', 'admin'), viewer: await join('v@example.com', 'viewer', 'viewer') };
  };

  it('members cannot invite/revoke; admins cannot grant admin', async () => {
    const { member, admin } = await team();
    await expect(svc.invite(member, { email: 'z@example.com', role: 'viewer' })).rejects.toThrow(/permission/);
    await expect(svc.invite(admin, { email: 'z@example.com', role: 'admin' })).rejects.toThrow(/permission/);
  });

  it('AU-29: a member cannot promote themselves', async () => {
    const { member } = await team();
    await expect(svc.changeRole(member, 'member', 'admin')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('AU-30: an admin cannot demote or remove an owner (or another admin)', async () => {
    const { admin } = await team();
    await expect(svc.changeRole(admin, 'owner', 'member')).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.removeMember(admin, 'owner')).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.changeRole(admin, 'admin', 'owner')).rejects.toMatchObject({ statusCode: 403 });
    // but may manage members/viewers within member/viewer
    expect((await svc.changeRole(admin, 'viewer', 'member')).role).toBe('member');
    await expect(svc.changeRole(admin, 'viewer', 'admin')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('AU-31: the last owner cannot demote themselves or leave (422); a second owner unblocks it', async () => {
    const { owner } = await team();
    await expect(svc.changeRole(owner, 'owner', 'admin')).rejects.toMatchObject({ statusCode: 422 });
    await expect(svc.removeMember(owner, 'owner')).rejects.toMatchObject({ statusCode: 422 });
    await svc.changeRole(owner, 'admin', 'owner');
    expect((await svc.changeRole(owner, 'owner', 'admin')).role).toBe('admin');
  });

  it('role change and removal revoke the target user sessions', async () => {
    const { owner } = await team();
    const mk = (id: string, userId: string) => sessions.create({ id, userId, tokenHash: id, activeOrganizationId: owner.organizationId, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 1e9), revokedAt: null, ip: null, userAgent: null });
    await mk('s-m', 'member');
    await mk('s-v', 'viewer');
    await svc.changeRole(owner, 'member', 'viewer');
    await svc.removeMember(owner, 'viewer');
    expect((await sessions.findById('s-m'))?.revokedAt).not.toBeNull();
    expect((await sessions.findById('s-v'))?.revokedAt).not.toBeNull();
    await expect(svc.resolveTenant(owner.organizationId, 'viewer')).rejects.toThrow(/not found/);
  });

  it('resolveTenant 404s for non-members', async () => {
    const { organization } = await setup();
    await expect(svc.resolveTenant(organization.id, 'stranger')).rejects.toThrow(/not found/);
  });
});

export const fakeRedis = (): RedisLike & { advance(ms: number): void } => {
  const store = new Map<string, { v: string; exp: number }>();
  const sets = new Map<string, Set<string>>();
  let t = 0;
  const alive = (k: string) => {
    const e = store.get(k);
    if (e && e.exp <= t) store.delete(k);
    return store.get(k);
  };
  return {
    advance: (ms) => void (t += ms),
    incr: async (k) => {
      const e = alive(k) ?? { v: '0', exp: Infinity };
      e.v = String(Number(e.v) + 1);
      store.set(k, e);
      return Number(e.v);
    },
    pexpire: async (k, ms) => {
      const e = alive(k);
      if (e) e.exp = t + ms;
      return e ? 1 : 0;
    },
    pttl: async (k) => {
      const e = alive(k);
      return e ? (e.exp === Infinity ? -1 : e.exp - t) : -2;
    },
    set: async (k, v, _m, ms) => {
      store.set(k, { v, exp: t + ms });
      return 'OK';
    },
    get: async (k) => alive(k)?.v ?? null,
    getdel: async (k) => {
      const v = alive(k)?.v ?? null;
      store.delete(k);
      return v;
    },
    del: async (...ks) => ks.filter((k) => store.delete(k)).length,
    sadd: async (k, ...m) => {
      const s = sets.get(k) ?? new Set();
      m.forEach((x) => s.add(x));
      sets.set(k, s);
      return m.length;
    },
    smembers: async (k) => [...(sets.get(k) ?? [])]
  };
};

describe('Redis adapters (fake client)', () => {
  it('RedisRateLimiter blocks after the limit and resets after the window', async () => {
    const r = fakeRedis();
    const rl = new RedisRateLimiter(r);
    for (let i = 0; i < 3; i++) expect((await rl.consume('k', 3, 1000)).allowed).toBe(true);
    const res = await rl.consume('k', 3, 1000);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterMs).toBeGreaterThan(0);
    r.advance(1001);
    expect((await rl.consume('k', 3, 1000)).allowed).toBe(true);
  });

  it('progressive lockout: doubles per extra failure, capped; reset clears', async () => {
    const p = { threshold: 3, windowMs: 10_000, baseLockMs: 1000, maxLockMs: 4000 };
    expect([1, 2, 3, 4, 5, 6].map((n) => lockDurationMs(n, p))).toEqual([0, 0, 1000, 2000, 4000, 4000]);
    const r = fakeRedis();
    const lo = new RedisLoginLockout(r, p);
    await lo.recordFailure('a');
    await lo.recordFailure('a');
    expect((await lo.isLocked('a')).locked).toBe(false);
    expect((await lo.recordFailure('a')).lockedForMs).toBe(1000);
    expect((await lo.isLocked('a')).locked).toBe(true);
    r.advance(1001);
    expect((await lo.isLocked('a')).locked).toBe(false);
    expect((await lo.recordFailure('a')).lockedForMs).toBe(2000);
    await lo.reset('a');
    expect((await lo.isLocked('a')).locked).toBe(false);
  });

  it('InMemoryLoginLockout follows the same progressive policy', async () => {
    let t = 0;
    const lo = new InMemoryLoginLockout({ now: () => new Date(t) }, { threshold: 2, windowMs: 10_000, baseLockMs: 1000, maxLockMs: 8000 });
    await lo.recordFailure('a');
    expect((await lo.recordFailure('a')).lockedForMs).toBe(1000);
    t += 1500;
    expect((await lo.recordFailure('a')).lockedForMs).toBe(2000);
    expect((await lo.isLocked('a')).retryAfterMs).toBe(2000);
  });

  it('RedisOneTimeTokenRepository: atomic single use, rehash and invalidate', async () => {
    const repo = new RedisOneTimeTokenRepository(fakeRedis());
    const base = { userId: 'u', purpose: 'password_reset' as const, usedAt: null, createdAt: now, expiresAt: new Date(Date.now() + 60_000) };
    await repo.create({ ...base, id: 't1', tokenHash: 'h1' });
    await repo.setTokenHash('t1', 'h1b');
    expect(await repo.consume('password_reset', 'h1', new Date())).toBeNull();
    const [a, b] = await Promise.all([repo.consume('password_reset', 'h1b', new Date()), repo.consume('password_reset', 'h1b', new Date())]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await repo.consume('email_verification', 'h1b', new Date())).toBeNull();
    await repo.create({ ...base, id: 't2', tokenHash: 'h2' });
    await repo.invalidateForUser('u', 'password_reset', new Date());
    expect(await repo.consume('password_reset', 'h2', new Date())).toBeNull();
    expect((await repo.findById('t2'))?.usedAt).toBeInstanceOf(Date);
  });
});

describe('SessionVerifier', () => {
  it('resolves a cookie token to user, organizationId and role', async () => {
    const { buildApp, signupAndLogin, SID } = await import( './helpers.js');
    const { defaultModuleDeps } = await import( '../src/modules/index.js');
    const { AuthService } = await import( '../src/modules/auth/application/auth.service.js');
    const { SessionVerifier } = await import( '../src/modules/auth/application/session-verifier.js');
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
  }, 30_000); // cold dynamic import of the server + real argon2id hashing; >5s on loaded CI runners
});
