import type { Session, SessionRepository } from '../domain/session.js';

/** Test/dev only. */
export class InMemorySessionRepository implements SessionRepository {
  readonly items = new Map<string, Session>();

  async create(session: Session) {
    this.items.set(session.id, { ...session });
    return session;
  }
  async findByTokenHash(tokenHash: string) {
    for (const s of this.items.values()) if (s.tokenHash === tokenHash) return { ...s };
    return null;
  }
  async findById(id: string) {
    const s = this.items.get(id);
    return s ? { ...s } : null;
  }
  async listActiveForUser(userId: string, now: Date) {
    return [...this.items.values()]
      .filter((s) => s.userId === userId && !s.revokedAt && s.expiresAt > now)
      .map((s) => ({ ...s }));
  }
  async touch(id: string, at: Date) {
    const s = this.items.get(id);
    if (s) s.lastSeenAt = at;
  }
  async revoke(id: string, at: Date) {
    const s = this.items.get(id);
    if (s) s.revokedAt = at;
  }
  async revokeAllForUser(userId: string, at: Date) {
    for (const s of this.items.values()) if (s.userId === userId && !s.revokedAt) s.revokedAt = at;
  }
}
