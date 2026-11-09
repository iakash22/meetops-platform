import type { NewLocationOutboxEvent } from '../application/new-location.js';
import type { GeoFields } from '../../../shared/geoip/provider.js';
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
  async findLastActiveOrganizationId(userId: string) {
    // Latest lastSeenAt, then createdAt; on a full tie (frozen test clocks) the later-created row wins.
    let last: Session | undefined;
    for (const s of this.items.values()) {
      if (s.userId !== userId || s.activeOrganizationId === null) continue;
      if (
        !last ||
        s.lastSeenAt.getTime() > last.lastSeenAt.getTime() ||
        (s.lastSeenAt.getTime() === last.lastSeenAt.getTime() &&
          s.createdAt.getTime() >= last.createdAt.getTime())
      )
        last = s;
    }
    return last?.activeOrganizationId ?? null;
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
  /** Outbox rows written by createWithOutbox (tests). */
  readonly outbox: NewLocationOutboxEvent[] = [];
  async knownLocations(userId: string) {
    const seen = new Map<string, { countryCode: string; region: string | null }>();
    for (const s of this.items.values()) {
      const cc = s.geo?.geoCountryCode;
      if (s.userId !== userId || !cc) continue;
      const region = s.geo?.geoRegion ?? null;
      seen.set(`${cc}|${region ?? ''}`, { countryCode: cc, region });
    }
    return [...seen.values()];
  }
  async createWithOutbox(session: Session, event: NewLocationOutboxEvent) {
    const s = await this.create(session);
    this.outbox.push(structuredClone(event));
    return s;
  }
  async updateIp(id: string, ip: string | null, geo: GeoFields) {
    const s = this.items.get(id);
    if (s) {
      s.ip = ip;
      s.geo = { ...geo };
    }
  }
  async revoke(id: string, at: Date) {
    const s = this.items.get(id);
    if (!s || s.revokedAt) return false;
    s.revokedAt = at;
    return true;
  }
  async revokeAllForUser(userId: string, at: Date) {
    for (const s of this.items.values()) if (s.userId === userId && !s.revokedAt) s.revokedAt = at;
  }
}
