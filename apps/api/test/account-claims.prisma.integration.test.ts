/**
 * OIDC review X1 against live Postgres as the app role: the takeover claim and the revocation of every session of the
 * account commit in ONE transaction. A failure inside the transaction rolls the credential change back too.
 * Skipped unless TEST_DATABASE_URL (meetops_app login) is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaAccountClaimStore } from '../src/modules/auth/infrastructure/prisma/prisma-account-claim.store.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  'account claims (live Postgres, one transaction)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    let users: PrismaUserRepository;
    let sessions: PrismaSessionRepository;

    beforeAll(() => {
      db = createPrismaClient({ databaseUrl: url! });
      users = new PrismaUserRepository(db);
      sessions = new PrismaSessionRepository(db);
    });
    afterAll(async () => {
      await db?.$disconnect();
    });

    async function squatted() {
      const now = new Date();
      const id = randomUUID();
      await users.create({
        id,
        email: `claim-${id.slice(0, 8)}@example.com`,
        name: 'Mallory',
        passwordHash: 'squatter-hash',
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      for (let i = 0; i < 2; i++) {
        await sessions.create({
          id: randomUUID(),
          userId: id,
          tokenHash: randomUUID(),
          activeOrganizationId: null,
          createdAt: now,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
          revokedAt: null,
          ip: null,
          userAgent: null,
        });
      }
      return id;
    }
    const liveSessions = (userId: string) =>
      db.session.count({ where: { userId, revokedAt: null } });

    it('claimForGoogle: links, verifies, drops the password and revokes every session; only once', async () => {
      const id = await squatted();
      const store = new PrismaAccountClaimStore(db);
      const sub = `g-${randomUUID().slice(0, 12)}`;
      expect(await store.claimForGoogle(id, sub, new Date())).toBe(true);
      const u = await users.findById(id);
      expect(u?.googleSub).toBe(sub);
      expect(u?.emailVerifiedAt).toBeTruthy();
      expect(u?.passwordHash).toBe('');
      expect(await liveSessions(id)).toBe(0);
      expect(await store.claimForGoogle(id, sub, new Date())).toBe(false);
    });

    it('claimForMailbox: verifies, drops password and Google subject, revokes every session', async () => {
      const id = await squatted();
      await db.user.update({ where: { id }, data: { googleSub: `stale-${id.slice(0, 8)}` } });
      const store = new PrismaAccountClaimStore(db);
      expect(await store.claimForMailbox(id, new Date())).toBe(true);
      const u = await users.findById(id);
      expect(u?.googleSub ?? null).toBeNull();
      expect(u?.passwordHash).toBe('');
      expect(u?.emailVerifiedAt).toBeTruthy();
      expect(await liveSessions(id)).toBe(0);
    });

    it('X1: a failure while revoking rolls the credential change back (nothing half-done)', async () => {
      const id = await squatted();
      // Same client, but inside the transaction the session revocation fails.
      const failing = new Proxy(db, {
        get(target, prop, recv) {
          if (prop !== '$transaction') return Reflect.get(target, prop, recv) as unknown;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p !== 'session') return Reflect.get(t, p, r) as unknown;
                    return {
                      updateMany: () => Promise.reject(new Error('db down')),
                    };
                  },
                }),
              ),
            );
        },
      });
      const store = new PrismaAccountClaimStore(failing);
      await expect(store.claimForGoogle(id, `g-${id.slice(0, 8)}`, new Date())).rejects.toThrow(
        'db down',
      );
      const u = await users.findById(id);
      expect(u?.googleSub ?? null).toBeNull();
      expect(u?.emailVerifiedAt).toBeNull();
      expect(u?.passwordHash).toBe('squatter-hash');
      expect(await liveSessions(id)).toBe(2);
      // The retry with a healthy connection does the whole claim.
      expect(
        await new PrismaAccountClaimStore(db).claimForGoogle(id, `g-${id.slice(0, 8)}`, new Date()),
      ).toBe(true);
      expect(await liveSessions(id)).toBe(0);
    });

    it('a Google subject held by another live account: false, nothing committed', async () => {
      const holder = await squatted();
      const sub = `g-${randomUUID().slice(0, 12)}`;
      await db.user.update({ where: { id: holder }, data: { googleSub: sub } });
      const id = await squatted();
      expect(await new PrismaAccountClaimStore(db).claimForGoogle(id, sub, new Date())).toBe(false);
      expect((await users.findById(id))?.emailVerifiedAt).toBeNull();
      expect(await liveSessions(id)).toBe(2);
    });

    /** Runs the claim with its transaction paused right after the session revocation (before COMMIT). */
    function pausedAfterRevoke() {
      let atPause!: () => void;
      let release!: () => void;
      const paused = new Promise<void>((r) => (atPause = r));
      const gate = new Promise<void>((r) => (release = r));
      const client = new Proxy(db, {
        get(target, prop, recv) {
          if (prop !== '$transaction') return Reflect.get(target, prop, recv) as unknown;
          return (fn: (tx: unknown) => Promise<unknown>) =>
            target.$transaction((tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p !== 'session') return Reflect.get(t, p, r) as unknown;
                    return {
                      updateMany: async (args: Parameters<typeof tx.session.updateMany>[0]) => {
                        const out = await tx.session.updateMany(args);
                        atPause();
                        await gate;
                        return out;
                      },
                    };
                  },
                }),
              ),
            );
        },
      });
      return { store: new PrismaAccountClaimStore(client), paused, release };
    }

    it('X4: the post-session re-read (FOR SHARE) waits for an in-flight takeover and sees its result', async () => {
      const id = await squatted();
      const { store, paused, release } = pausedAfterRevoke();
      const claim = store.claimForMailbox(id, new Date());
      await paused; // users row updated and sessions revoked, NOT committed yet
      // The in-flight login now writes its session (after the claim's revocation statement) and re-reads.
      const now = new Date();
      const late = randomUUID();
      await sessions.create({
        id: late,
        userId: id,
        tokenHash: randomUUID(),
        activeOrganizationId: null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
        revokedAt: null,
        ip: null,
        userAgent: null,
      });
      let settled = false;
      const reread = users.readCredentials(id).finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 400));
      // A plain read would already have returned the old password hash; FOR SHARE waits on the row lock.
      expect(settled).toBe(false);
      release();
      expect(await claim).toBe(true);
      const c = await reread;
      expect(c?.passwordHash).toBe('');
      expect(c?.emailVerifiedAt).toBeTruthy();
      // The caller (AuthService.stillHolds) then revokes the late session; revoke reports it was live.
      expect(await sessions.revoke(late, new Date())).toBe(true);
      expect(await sessions.revoke(late, new Date())).toBe(false);
      expect(await liveSessions(id)).toBe(0);
    });

    it('X4: a login rehash cannot write a hash back over a password the takeover removed', async () => {
      const id = await squatted();
      expect(await users.replacePasswordHash(id, 'squatter-hash', 'rehashed')).toBe(true);
      expect(await new PrismaAccountClaimStore(db).claimForMailbox(id, new Date())).toBe(true);
      expect(await users.replacePasswordHash(id, 'rehashed', 'rehashed-again')).toBe(false);
      expect((await users.findById(id))?.passwordHash).toBe('');
    });
  },
);
