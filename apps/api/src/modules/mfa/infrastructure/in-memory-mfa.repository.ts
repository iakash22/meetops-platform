import type {
  ActivateFactorInput,
  MfaFactorRecord,
  MfaRepository,
} from '../domain/mfa.repository.js';

interface CodeRow {
  userId: string;
  factorId: string;
  codeHash: string;
  usedAt: Date | null;
}

/**
 * Test/dev only. `onMfaEnabledChange` mirrors users.mfa_enabled_at (wired to InMemoryUserRepository.setMfaEnabledAt);
 * the Prisma repository writes that column in the same transaction instead.
 */
export class InMemoryMfaRepository implements MfaRepository {
  readonly factors = new Map<string, MfaFactorRecord>();
  readonly codes: CodeRow[] = [];
  constructor(
    private readonly onMfaEnabledChange: (
      userId: string,
      at: Date | null,
    ) => void | Promise<void> = () => {},
  ) {}

  private own(userId: string, factorId: string) {
    const f = this.factors.get(factorId);
    return f && f.userId === userId ? f : null;
  }
  async listFactors(userId: string) {
    return [...this.factors.values()]
      .filter((f) => f.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((f) => structuredClone(f));
  }
  async findFactor(userId: string, factorId: string) {
    const f = this.own(userId, factorId);
    return f ? structuredClone(f) : null;
  }
  async findActiveTotp(userId: string) {
    for (const f of this.factors.values())
      if (f.userId === userId && f.status === 'active' && f.type === 'totp')
        return structuredClone(f);
    return null;
  }
  async createPending(factor: MfaFactorRecord) {
    for (const [id, f] of this.factors)
      if (f.userId === factor.userId && f.status === 'pending') this.factors.delete(id);
    this.factors.set(factor.id, structuredClone(factor));
  }
  async activate(i: ActivateFactorInput) {
    const f = this.own(i.userId, i.factorId);
    if (!f || f.status !== 'pending' || !f.pendingExpiresAt || f.pendingExpiresAt <= i.at)
      return false;
    for (const [id, other] of this.factors)
      if (other.userId === i.userId && other.status === 'active' && id !== f.id)
        await this.drop(id);
    f.status = 'active';
    f.confirmedAt = i.at;
    f.pendingExpiresAt = null;
    f.lastUsedStep = i.step;
    f.lastUsedAt = i.at;
    for (const codeHash of i.recoveryHashes)
      this.codes.push({ userId: i.userId, factorId: f.id, codeHash, usedAt: null });
    await this.onMfaEnabledChange(i.userId, i.at);
    return true;
  }
  async advanceStep(userId: string, factorId: string, step: number, at: Date) {
    const f = this.own(userId, factorId);
    if (!f || f.status !== 'active') return false;
    if (f.lastUsedStep !== null && f.lastUsedStep >= step) return false;
    f.lastUsedStep = step;
    f.lastUsedAt = at;
    return true;
  }
  async consumeRecoveryCode(userId: string, factorId: string, codeHash: string, at: Date) {
    const row = this.codes.find(
      (c) => c.userId === userId && c.factorId === factorId && c.codeHash === codeHash && !c.usedAt,
    );
    if (!row) return false;
    row.usedAt = at;
    const f = this.own(userId, factorId);
    if (f) f.lastUsedAt = at;
    return true;
  }
  async countUnusedRecoveryCodes(userId: string, factorId: string) {
    return this.codes.filter((c) => c.userId === userId && c.factorId === factorId && !c.usedAt)
      .length;
  }
  async replaceRecoveryCodes(
    userId: string,
    factorId: string,
    secretEnc: string,
    secretKeyId: string,
    hashes: string[],
  ) {
    const f = this.own(userId, factorId);
    if (!f || f.status !== 'active') return false;
    f.secretEnc = secretEnc;
    f.secretKeyId = secretKeyId;
    this.dropCodes(factorId);
    for (const codeHash of hashes) this.codes.push({ userId, factorId, codeHash, usedAt: null });
    return true;
  }
  async deleteFactor(userId: string, factorId: string) {
    if (!this.own(userId, factorId)) return false;
    await this.drop(factorId);
    if (!(await this.findActiveTotp(userId))) await this.onMfaEnabledChange(userId, null);
    return true;
  }
  private dropCodes(factorId: string) {
    for (let i = this.codes.length - 1; i >= 0; i--)
      if (this.codes[i]!.factorId === factorId) this.codes.splice(i, 1);
  }
  private async drop(factorId: string) {
    this.factors.delete(factorId);
    this.dropCodes(factorId);
  }
}
