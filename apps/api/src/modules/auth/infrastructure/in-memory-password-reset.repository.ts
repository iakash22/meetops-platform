import type { PasswordResetRepository, PasswordResetToken } from '../domain/password-reset.js';

/** Test/dev only. */
export class InMemoryPasswordResetRepository implements PasswordResetRepository {
  private readonly items = new Map<string, PasswordResetToken>();
  async create(t: PasswordResetToken) {
    this.items.set(t.id, { ...t });
    return t;
  }
  async findByTokenHash(tokenHash: string) {
    return [...this.items.values()].find((t) => t.tokenHash === tokenHash) ?? null;
  }
  async markUsed(id: string, at: Date) {
    const t = this.items.get(id);
    if (t) t.usedAt = at;
  }
}
