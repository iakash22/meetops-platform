/**
 * Live Postgres (RLS, meetops_app role) + Redis. Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://meetops_app:...@127.0.0.1:55433/meetops TEST_REDIS_URL=redis://127.0.0.1:56380 pnpm vitest run test/prisma.integration.test.ts
 * The schema must be migrated (prisma migrate deploy) with the P1-DB-3 chain.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { buildApp, signupAndLogin, type App } from './helpers.js';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import {
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaOrganizationRepository
} from '../src/modules/organizations/infrastructure/prisma/prisma.repositories.js';
import { RedisLoginLockout, RedisRateLimiter, type RedisLike } from '../src/modules/auth/infrastructure/rate-limit/redis.js';
import { PrismaOneTimeTokenRepository } from '../src/modules/auth/infrastructure/prisma/prisma-one-time-token.repository.js';

const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

describe.skipIf(!url)('Prisma + Redis adapters against live Postgres (RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  let redis: Redis;
  let app: App;
  const sfx = randomUUID().slice(0, 8);
  const email = (n: string) => `${n}-${sfx}@example.com`;

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    redis = new Redis(redisUrl, { keyPrefix: `test:${sfx}:` });
    const r = redis as unknown as RedisLike;
    app = await buildApp({
      users: new PrismaUserRepository(db),
      sessions: new PrismaSessionRepository(db),
      organizations: new PrismaOrganizationRepository(db),
      memberships: new PrismaMembershipRepository(db),
      invitations: new PrismaInvitationRepository(db),
      audit: new PrismaAuditLog(db),
      oneTimeTokens: new PrismaOneTimeTokenRepository(db),
      // >5 signups/hour from one inject IP; the Redis limiter is covered by its own test below.
      rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
      lockout: new RedisLoginLockout(r)
    });
  });
  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await db?.$disconnect();
  });

  it('RedisRateLimiter against real Redis', async () => {
    const rl = new RedisRateLimiter(redis);
    for (let i = 0; i < 2; i++) expect((await rl.consume('live', 2, 5000)).allowed).toBe(true);
    const r = await rl.consume('live', 2, 5000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('connects as the non-bypass app role', async () => {
    const [me] = await db.$queryRaw<{ current_user: string; rolbypassrls: boolean }[]>`
      SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`;
    expect(me?.rolbypassrls).toBe(false);
  });

  it('full flow: signup → verify → login → org → invite → accept → role change → last owner', async () => {
    const owner = await signupAndLogin(app, email('owner'));
    const org = await owner.post('/orgs', { name: `Live ${sfx}` });
    expect(org.statusCode).toBe(201);
    const id = org.json().organization.id as string;

    const session = (await owner.get('/auth/session')).json();
    expect(session).toMatchObject({ activeOrganizationId: id, role: 'owner' });
    expect(session.organizations.map((o: { id: string }) => o.id)).toContain(id);

    const mem = await signupAndLogin(app, email('mem'));
    expect((await owner.post(`/orgs/${id}/invitations`, { email: email('mem'), role: 'member' })).statusCode).toBe(201);
    const token = app.token(email('mem'), 'invitation')!;
    expect(token).not.toContain(id);
    const acc = await mem.post('/invitations/accept', { token });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().role).toBe('member');
    expect((await mem.post('/invitations/accept', { token })).statusCode).toBe(404);

    const memId = (await mem.get('/auth/session')).json().user.id as string;
    const ownerId = session.user.id as string;
    expect((await mem.patch(`/orgs/${id}/members/${memId}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await owner.patch(`/orgs/${id}/members/${ownerId}`, { role: 'admin' })).statusCode).toBe(422);
    expect((await owner.patch(`/orgs/${id}/members/${memId}`, { role: 'viewer' })).statusCode).toBe(200);
    expect((await mem.get('/auth/session')).statusCode).toBe(401);

    const members = (await owner.get(`/orgs/${id}/members`)).json().items as { role: string }[];
    expect(members.map((m) => m.role).sort()).toEqual(['owner', 'viewer']);

    const audits = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${id}, true)`;
      return tx.auditEvent.findMany({ where: { organizationId: id }, select: { action: true } });
    });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['org.create', 'invitation.create', 'invitation.accepted', 'membership.role_change']));
  });

  it('already_member: invite of an active member is 409; a stale invite cannot demote the owner (accept → 409, nothing changes)', async () => {
    const owner = await signupAndLogin(app, email('am-owner'));
    const id = (await owner.post('/orgs', { name: `AM ${sfx}` })).json().organization.id as string;
    const ownerId = (await owner.get('/auth/session')).json().user.id as string;
    expect((await owner.post(`/orgs/${id}/invitations`, { email: email('am-admin'), role: 'admin' })).statusCode).toBe(201);
    const admin = await signupAndLogin(app, email('am-admin'));
    expect((await admin.post('/invitations/accept', { token: app.token(email('am-admin'), 'invitation')! })).statusCode).toBe(200);
    const adminId = (await admin.get('/auth/session')).json().user.id as string;

    const dup = await admin.post(`/orgs/${id}/invitations`, { email: email('am-owner'), role: 'viewer' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');

    // A pending invite for the owner's address that predates the guard (planted through the RLS repository).
    const token = randomUUID() + randomUUID();
    const now = new Date();
    const invRepo = new PrismaInvitationRepository(db);
    const invId = randomUUID();
    await invRepo.create(id, {
      id: invId, organizationId: id, email: email('am-owner'), role: 'viewer',
      tokenHash: createHash('sha256').update(token).digest('hex'), invitedById: adminId, status: 'pending',
      expiresAt: new Date(now.getTime() + 3_600_000), createdAt: now, acceptedAt: null, acceptedById: null, revokedAt: null, deletedAt: null
    });
    const acc = await owner.post('/invitations/accept', { token });
    expect(acc.statusCode).toBe(409);
    expect(acc.json().error).toMatchObject({ code: 'CONFLICT', message: 'This person is already a member of the organization' });
    expect((await owner.get('/auth/session')).json().role).toBe('owner');
    const members = (await owner.get(`/orgs/${id}/members`)).json();
    expect(members.nextCursor).toBeNull();
    expect(members.items.find((m: { userId: string }) => m.userId === ownerId).role).toBe('owner');
    expect((await invRepo.findPendingByEmail(id, email('am-owner')))?.id).toBe(invId);

    // Email visibility on the live member list: present for owner/admin.
    for (const m of members.items) expect(m.user.email).toBeDefined();
  });

  it('RLS: memberships of another org are invisible through the repository', async () => {
    const a = await signupAndLogin(app, email('a'));
    const orgA = (await a.post('/orgs', { name: `A ${sfx}` })).json().organization.id as string;
    const aId = (await a.get('/auth/session')).json().user.id as string;
    const repo = new PrismaMembershipRepository(db);
    expect(await repo.find(orgA, aId)).not.toBeNull();
    const b = await signupAndLogin(app, email('b'));
    const orgB = (await b.post('/orgs', { name: `B ${sfx}` })).json().organization.id as string;
    expect(await repo.find(orgB, aId)).toBeNull();
    expect((await repo.listByUser(aId)).map((m) => m.organizationId)).toEqual([orgA]);
    // raw read without org context sees nothing (forced RLS, fail closed)
    expect(await db.membership.count({ where: { userId: aId } })).toBe(0);
  });

  it('sessions: list + revoke by id + password reset revokes all', async () => {
    const c = await signupAndLogin(app, email('sess'));
    const list = (await c.get('/auth/sessions')).json();
    expect(list.items).toHaveLength(1);
    await c.post('/auth/forgot-password', { email: email('sess') });
    const t = app.token(email('sess'), 'password_reset')!;
    const anon = (await import('./helpers.js')).Client;
    const x = new anon(app);
    expect((await x.post('/auth/reset-password', { token: t, password: 'another-long-password' })).statusCode).toBe(204);
    expect((await x.post('/auth/reset-password', { token: t, password: 'another-long-password' })).statusCode).toBe(400);
    expect((await c.get('/auth/session')).statusCode).toBe(401);
  });

  it('D4: concurrent consumption of one reset token → exactly one wins (UPDATE ... RETURNING)', async () => {
    await signupAndLogin(app, email('race'));
    const { Client } = await import('./helpers.js');
    const x = new Client(app);
    await x.post('/auth/forgot-password', { email: email('race') });
    const t = app.token(email('race'), 'password_reset')!;
    const rs = await Promise.all([1, 2, 3].map(() => new Client(app).post('/auth/reset-password', { token: t, password: 'race-password-long' })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([204, 400, 400]);
  });

  it('pre-tenant audit events are written as global rows (createMany, not readable by the app)', async () => {
    await signupAndLogin(app, email('glob'));
    // the app role cannot SELECT null-org rows; the insert succeeding is the assertion
    expect(await db.auditEvent.count({ where: { organizationId: null } })).toBe(0);
  });
});
