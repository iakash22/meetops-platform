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
  async revoke(id: string, at: Date) {
    const s = this.items.get(id);
    if (s) s.revokedAt = at;
  }
  async setActiveOrganization(id: string, organizationId: string | null) {
    const s = this.items.get(id);
    if (s) s.activeOrganizationId = organizationId;
  }
}
