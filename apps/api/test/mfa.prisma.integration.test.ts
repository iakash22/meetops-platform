/**
 * ADR-021 MFA storage against live Postgres as the app role (forced user-scoped RLS on mfa_factors and
 * mfa_recovery_codes): activation in one unit with users.mfa_enabled_at, the TOTP replay CAS, single-use recovery
 * codes, and isolation between users. Skipped unless TEST_DATABASE_URL (meetops_app login) is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, type DatabaseClient } from '@meetops/database';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaMfaRepository } from '../src/modules/mfa/infrastructure/prisma-mfa.repository.js';
import { PrismaAccountClaimStore } from '../src/modules/auth/infrastructure/prisma/prisma-account-claim.store.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  'ADR-021 MFA storage (live Postgres, forced RLS)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    let users: PrismaUserRepository;
    let mfa: PrismaMfaRepository;

    beforeAll(() => {
      db = createPrismaClient({ databaseUrl: url! });
      users = new PrismaUserRepository(db);
      mfa = new PrismaMfaRepository(db);
    });
    afterAll(async () => {
      await db?.$disconnect();
    });

    async function user(verified = true) {
      const now = new Date();
      const id = randomUUID();
      await users.create({
        id,
        email: `mfa-${id.slice(0, 8)}@example.com`,
        name: 'Ada',
        passwordHash: 'hash',
        emailVerifiedAt: verified ? now : null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      return id;
    }
    async function pending(userId: string, now = new Date()) {
      const id = randomUUID();
      await mfa.createPending({
        id,
        userId,
        type: 'totp',
        status: 'pending',
        secretEnc: `v1.test.${id}`,
        secretKeyId: 'test',
        lastUsedStep: null,
        pendingExpiresAt: new Date(now.getTime() + 600_000),
        confirmedAt: null,
        lastUsedAt: null,
        createdAt: now,
      });
      return id;
    }
    const hashes = (n: number) => Array.from({ length: n }, () => randomUUID().replaceAll('-', ''));

    it('activation stores the codes and sets users.mfa_enabled_at in one unit; a replacement retires the old factor', async () => {
      const u = await user();
      const f1 = await pending(u);
      const now = new Date();
      expect(
        await mfa.activate({
          userId: u,
          factorId: f1,
          step: 100,
          at: now,
          recoveryHashes: hashes(10),
        }),
      ).toBe(true);
      expect((await users.findById(u))?.mfaEnabledAt).toBeTruthy();
      expect(await mfa.countUnusedRecoveryCodes(u, f1)).toBe(10);
      // Activating twice is a no-op (no longer pending).
      expect(
        await mfa.activate({
          userId: u,
          factorId: f1,
          step: 101,
          at: now,
          recoveryHashes: hashes(10),
        }),
      ).toBe(false);
      const f2 = await pending(u);
      expect(
        await mfa.activate({
          userId: u,
          factorId: f2,
          step: 102,
          at: now,
          recoveryHashes: hashes(10),
        }),
      ).toBe(true);
      const factors = await mfa.listFactors(u);
      expect(factors.map((f) => [f.id, f.status])).toEqual([[f2, 'active']]);
      expect(await mfa.countUnusedRecoveryCodes(u, f1)).toBe(0);
    });

    it('an expired pending factor cannot be activated', async () => {
      const u = await user();
      const past = new Date(Date.now() - 3_600_000);
      const f = await pending(u, past);
      expect(
        await mfa.activate({
          userId: u,
          factorId: f,
          step: 1,
          at: new Date(),
          recoveryHashes: hashes(10),
        }),
      ).toBe(false);
      expect((await users.findById(u))?.mfaEnabledAt ?? null).toBeNull();
    });

    it('the replay guard only moves forwards, also under concurrency', async () => {
      const u = await user();
      const f = await pending(u);
      await mfa.activate({
        userId: u,
        factorId: f,
        step: 200,
        at: new Date(),
        recoveryHashes: hashes(10),
      });
      expect(await mfa.advanceStep(u, f, 200, new Date())).toBe(false);
      expect(await mfa.advanceStep(u, f, 199, new Date())).toBe(false);
      const race = await Promise.all(
        [1, 2, 3, 4].map(() => mfa.advanceStep(u, f, 201, new Date())),
      );
      expect(race.filter(Boolean)).toHaveLength(1);
      expect((await mfa.findActiveTotp(u))?.lastUsedStep).toBe(201);
    });

    it('a recovery code is single-use, also under concurrency', async () => {
      const u = await user();
      const f = await pending(u);
      const hs = hashes(10);
      await mfa.activate({ userId: u, factorId: f, step: 1, at: new Date(), recoveryHashes: hs });
      const race = await Promise.all(
        [1, 2, 3].map(() => mfa.consumeRecoveryCode(u, f, hs[0]!, new Date())),
      );
      expect(race.filter(Boolean)).toHaveLength(1);
      expect(await mfa.consumeRecoveryCode(u, f, 'unknown', new Date())).toBe(false);
      expect(await mfa.countUnusedRecoveryCodes(u, f)).toBe(9);
    });

    it('forced RLS: another user context and the bare connection see nothing', async () => {
      const a = await user();
      const b = await user();
      const f = await pending(a);
      await mfa.activate({
        userId: a,
        factorId: f,
        step: 1,
        at: new Date(),
        recoveryHashes: hashes(10),
      });
      expect(await mfa.findFactor(b, f)).toBeNull();
      expect(await mfa.advanceStep(b, f, 5, new Date())).toBe(false);
      expect(await mfa.deleteFactor(b, f)).toBe(false);
      expect(await db.mfaFactor.count({ where: { id: f } })).toBe(0);
      expect(await db.mfaRecoveryCode.count({ where: { factorId: f } })).toBe(0);
    });

    it('deleting the last active factor clears users.mfa_enabled_at and cascades the codes', async () => {
      const u = await user();
      const f = await pending(u);
      await mfa.activate({
        userId: u,
        factorId: f,
        step: 1,
        at: new Date(),
        recoveryHashes: hashes(10),
      });
      expect(await mfa.deleteFactor(u, f)).toBe(true);
      expect((await users.findById(u))?.mfaEnabledAt ?? null).toBeNull();
      expect(await mfa.countUnusedRecoveryCodes(u, f)).toBe(0);
    });

    // ADR-021 OQ-15 (MFA-TO-01..03, from the #470 plan update): the takeover claim deletes the
    // squatter's factors, pending enrolment and recovery hashes in its own transaction (no follow-up step involved).
    for (const kind of ['mailbox', 'google'] as const) {
      it(`MFA-TO-0${kind === 'mailbox' ? 1 : 2}/03: the ${kind} claim clears every factor in the claim transaction`, async () => {
        const u = await user(false);
        const active = await pending(u);
        await mfa.activate({
          userId: u,
          factorId: active,
          step: 1,
          at: new Date(),
          recoveryHashes: hashes(10),
        });
        await pending(u);
        expect(await mfa.listFactors(u)).toHaveLength(2);
        const store = new PrismaAccountClaimStore(db);
        const sub = `1${randomUUID().replaceAll('-', '').replace(/[a-f]/g, '7').slice(0, 20)}`;
        const claimed =
          kind === 'mailbox'
            ? await store.claimForMailbox(u, new Date())
            : await store.claimForGoogle(u, sub, new Date());
        expect(claimed).toBe(true);
        expect(await mfa.listFactors(u)).toEqual([]);
        expect(await mfa.countUnusedRecoveryCodes(u, active)).toBe(0);
        expect((await users.findById(u))?.mfaEnabledAt ?? null).toBeNull();
      });
    }

    it('OQ-15: a claim that does not apply (already verified) leaves the factors alone', async () => {
      const u = await user(true);
      const f = await pending(u);
      await mfa.activate({
        userId: u,
        factorId: f,
        step: 1,
        at: new Date(),
        recoveryHashes: hashes(10),
      });
      expect(await new PrismaAccountClaimStore(db).claimForMailbox(u, new Date())).toBe(false);
      expect(await mfa.listFactors(u)).toHaveLength(1);
    });
  },
);
