import {
  getPrismaClient,
  withUserContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '../../../shared/prisma/context.js';
import type {
  ActivateFactorInput,
  MfaFactorRecord,
  MfaFactorStatus,
  MfaRepository,
} from '../domain/mfa.repository.js';

type Row = {
  id: string;
  userId: string;
  type: string;
  status: string;
  secretEnc: string;
  secretKeyId: string;
  lastUsedStep: bigint | null;
  pendingExpiresAt: Date | null;
  confirmedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

const toRecord = (r: Row): MfaFactorRecord => ({
  id: r.id,
  userId: r.userId,
  type: 'totp',
  status: r.status as MfaFactorStatus,
  secretEnc: r.secretEnc,
  secretKeyId: r.secretKeyId,
  lastUsedStep: r.lastUsedStep === null ? null : Number(r.lastUsedStep),
  pendingExpiresAt: r.pendingExpiresAt,
  confirmedAt: r.confirmedAt,
  lastUsedAt: r.lastUsedAt,
  createdAt: r.createdAt,
});

/**
 * mfa_factors / mfa_recovery_codes have user-scoped forced RLS: every call runs in withUserContext(userId), so a bug
 * that passes another user's factor id finds nothing. users is global (no RLS); mfa_enabled_at is written in the same
 * transaction as the factor change.
 */
export class PrismaMfaRepository implements MfaRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}

  private tx<T>(userId: string, fn: (tx: DatabaseTransaction) => Promise<T>) {
    return withUserContext(userId, fn, { client: this.db });
  }

  async listFactors(userId: string) {
    const rows = await this.tx(userId, (tx) =>
      tx.mfaFactor.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    );
    return rows.map(toRecord);
  }
  async findFactor(userId: string, factorId: string) {
    const r = await this.tx(userId, (tx) =>
      tx.mfaFactor.findFirst({ where: { id: factorId, userId } }),
    );
    return r ? toRecord(r) : null;
  }
  async findActiveTotp(userId: string) {
    const r = await this.tx(userId, (tx) =>
      tx.mfaFactor.findFirst({ where: { userId, status: 'active', type: 'totp' } }),
    );
    return r ? toRecord(r) : null;
  }
  async createPending(f: MfaFactorRecord) {
    await this.tx(f.userId, async (tx) => {
      await tx.mfaFactor.deleteMany({ where: { userId: f.userId, status: 'pending' } });
      await tx.mfaFactor.create({
        data: {
          id: f.id,
          userId: f.userId,
          type: f.type,
          status: 'pending',
          secretEnc: f.secretEnc,
          secretKeyId: f.secretKeyId,
          pendingExpiresAt: f.pendingExpiresAt,
          createdAt: f.createdAt,
        },
      });
    });
  }
  async activate(i: ActivateFactorInput) {
    return this.tx(i.userId, async (tx) => {
      // Retire the old active factor first (partial unique index: one active TOTP per user).
      const pending = await tx.mfaFactor.findFirst({
        where: {
          id: i.factorId,
          userId: i.userId,
          status: 'pending',
          pendingExpiresAt: { gt: i.at },
        },
        select: { id: true },
      });
      if (!pending) return false;
      await tx.mfaFactor.deleteMany({
        where: { userId: i.userId, status: 'active', NOT: { id: i.factorId } },
      });
      const r = await tx.mfaFactor.updateMany({
        where: {
          id: i.factorId,
          userId: i.userId,
          status: 'pending',
          pendingExpiresAt: { gt: i.at },
        },
        data: {
          status: 'active',
          confirmedAt: i.at,
          pendingExpiresAt: null,
          lastUsedStep: BigInt(i.step),
          lastUsedAt: i.at,
        },
      });
      if (r.count !== 1) throw new Error('mfa factor activation lost a race');
      await tx.mfaRecoveryCode.createMany({
        data: i.recoveryHashes.map((codeHash) => ({
          userId: i.userId,
          factorId: i.factorId,
          codeHash,
        })),
      });
      await tx.user.updateMany({
        where: { id: i.userId, mfaEnabledAt: null },
        data: { mfaEnabledAt: i.at },
      });
      return true;
    });
  }
  async advanceStep(userId: string, factorId: string, step: number, at: Date) {
    const r = await this.tx(userId, (tx) =>
      tx.mfaFactor.updateMany({
        where: {
          id: factorId,
          userId,
          status: 'active',
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
        },
        data: { lastUsedStep: BigInt(step), lastUsedAt: at },
      }),
    );
    return r.count === 1;
  }
  async consumeRecoveryCode(userId: string, factorId: string, codeHash: string, at: Date) {
    return this.tx(userId, async (tx) => {
      const r = await tx.mfaRecoveryCode.updateMany({
        where: { userId, factorId, codeHash, usedAt: null },
        data: { usedAt: at },
      });
      if (r.count !== 1) return false;
      await tx.mfaFactor.updateMany({ where: { id: factorId, userId }, data: { lastUsedAt: at } });
      return true;
    });
  }
  async countUnusedRecoveryCodes(userId: string, factorId: string) {
    return this.tx(userId, (tx) =>
      tx.mfaRecoveryCode.count({ where: { userId, factorId, usedAt: null } }),
    );
  }
  async replaceRecoveryCodes(
    userId: string,
    factorId: string,
    secretEnc: string,
    secretKeyId: string,
    hashes: string[],
  ) {
    return this.tx(userId, async (tx) => {
      const r = await tx.mfaFactor.updateMany({
        where: { id: factorId, userId, status: 'active' },
        data: { secretEnc, secretKeyId },
      });
      if (r.count !== 1) return false;
      await tx.mfaRecoveryCode.deleteMany({ where: { userId, factorId } });
      await tx.mfaRecoveryCode.createMany({
        data: hashes.map((codeHash) => ({ userId, factorId, codeHash })),
      });
      return true;
    });
  }
  async deleteAllForUser(userId: string) {
    await this.tx(userId, async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await tx.user.updateMany({ where: { id: userId }, data: { mfaEnabledAt: null } });
    });
  }
  async deleteFactor(userId: string, factorId: string) {
    return this.tx(userId, async (tx) => {
      const r = await tx.mfaFactor.deleteMany({ where: { id: factorId, userId } });
      if (r.count !== 1) return false;
      const left = await tx.mfaFactor.count({ where: { userId, status: 'active' } });
      if (left === 0)
        await tx.user.updateMany({ where: { id: userId }, data: { mfaEnabledAt: null } });
      return true;
    });
  }
}
