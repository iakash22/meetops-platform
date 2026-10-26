import type {
  OneTimeToken,
  OneTimeTokenPurpose,
  OneTimeTokenRepository,
} from '../domain/one-time-token.js';

/** Test/dev only. consume() is synchronous check-and-set, so it is atomic in-process. */
export class InMemoryOneTimeTokenRepository implements OneTimeTokenRepository {
  readonly items = new Map<string, OneTimeToken>();
  async create(t: OneTimeToken) {
    this.items.set(t.id, { ...t });
    return t;
  }
  async findById(id: string) {
    const t = this.items.get(id);
    return t ? { ...t } : null;
  }
  async setTokenHash(id: string, tokenHash: string) {
    const t = this.items.get(id);
    if (t) t.tokenHash = tokenHash;
  }
  async consume(purpose: OneTimeTokenPurpose, tokenHash: string, now: Date) {
    for (const t of this.items.values()) {
      if (t.purpose === purpose && t.tokenHash === tokenHash && !t.usedAt && t.expiresAt > now) {
        t.usedAt = now;
        return { ...t };
      }
    }
    return null;
  }
  async invalidateForUser(userId: string, purpose: OneTimeTokenPurpose, now: Date) {
    for (const t of this.items.values())
      if (t.userId === userId && t.purpose === purpose && !t.usedAt) t.usedAt = now;
  }
}
