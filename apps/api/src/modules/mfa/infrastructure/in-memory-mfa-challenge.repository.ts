import type { MfaChallenge, MfaChallengeRepository } from '../domain/challenge.js';

/** Test/dev only. Every method is a synchronous check-and-set, so it is atomic in-process. */
export class InMemoryMfaChallengeRepository implements MfaChallengeRepository {
  readonly items = new Map<string, MfaChallenge>();
  private live(c: MfaChallenge | undefined, now: Date): c is MfaChallenge {
    return !!c && c.purpose === 'mfa_challenge' && !c.usedAt && c.expiresAt > now;
  }
  async create(c: MfaChallenge) {
    for (const x of this.items.values())
      if (x.tokenHash === c.tokenHash) throw new Error('mfa_challenges_token_hash_key');
    this.items.set(c.id, { ...c });
  }
  async findLive(tokenHash: string, now: Date) {
    for (const c of this.items.values())
      if (c.tokenHash === tokenHash && this.live(c, now)) return { ...c };
    return null;
  }
  async reserveAttempt(id: string, userId: string, maxAttempts: number, now: Date) {
    const c = this.items.get(id);
    if (!this.live(c, now) || c.userId !== userId || c.attempts >= maxAttempts) return null;
    c.attempts += 1;
    return { ...c };
  }
  async consume(id: string, userId: string, now: Date) {
    const c = this.items.get(id);
    if (!this.live(c, now) || c.userId !== userId || c.attempts <= 0) return null;
    c.usedAt = now;
    return { ...c };
  }
  async recordFailure(id: string, now: Date, maxAttempts: number) {
    const c = this.items.get(id);
    if (!c) return maxAttempts;
    if (c.usedAt || c.expiresAt <= now) return c.attempts >= maxAttempts ? c.attempts : maxAttempts;
    if (c.attempts >= maxAttempts && !c.usedAt) c.usedAt = now;
    return c.attempts;
  }
  async invalidateForUser(userId: string, now: Date) {
    for (const c of this.items.values()) if (c.userId === userId && !c.usedAt) c.usedAt = now;
  }
}
