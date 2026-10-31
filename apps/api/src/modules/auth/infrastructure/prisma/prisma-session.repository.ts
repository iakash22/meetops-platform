import {
  getPrismaClient,
  withOrgContext,
  type DatabaseClient,
} from '../../../../shared/prisma/context.js';
import type { NewLocationOutboxEvent } from '../../application/new-location.js';
import type { Session, SessionRepository } from '../../domain/session.js';
import type { GeoFields } from '../../../../shared/geoip/provider.js';

type Row = {
  id: string;
  userId: string;
  tokenHash: string;
  activeOrgId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  geoCountryCode: string | null;
  geoApproximate: boolean | null;
};
const toSession = (r: Row): Session => ({
  id: r.id,
  userId: r.userId,
  tokenHash: r.tokenHash,
  activeOrganizationId: r.activeOrgId,
  createdAt: r.createdAt,
  lastSeenAt: r.lastSeenAt,
  expiresAt: r.absoluteExpiresAt,
  revokedAt: r.revokedAt,
  ip: r.ipAddress,
  userAgent: r.userAgent,
  geo: {
    geoCity: r.geoCity,
    geoRegion: r.geoRegion,
    geoCountry: r.geoCountry,
    geoCountryCode: r.geoCountryCode,
    geoApproximate: r.geoApproximate ? true : null,
  },
});
const geoData = (g: GeoFields | undefined) => ({
  geoCity: g?.geoCity ?? null,
  geoRegion: g?.geoRegion ?? null,
  geoCountry: g?.geoCountry ?? null,
  geoCountryCode: g?.geoCountryCode ?? null,
  geoApproximate: g?.geoApproximate ?? null,
});

/**
 * sessions is global (resolved before any org context). The domain's expiresAt is the absolute
 * cap; the idle window is enforced in AuthService and mirrored into expires_at (sliding) on touch.
 */
export class PrismaSessionRepository implements SessionRepository {
  constructor(
    private readonly db: DatabaseClient = getPrismaClient(),
    private readonly idleTimeoutMs = 30 * 60_000,
  ) {}
  private idle(at: Date, cap: Date) {
    return new Date(Math.min(at.getTime() + this.idleTimeoutMs, cap.getTime()));
  }
  private sessionData(s: Session) {
    return {
      id: s.id,
      userId: s.userId,
      tokenHash: s.tokenHash,
      activeOrgId: s.activeOrganizationId,
      ipAddress: s.ip,
      userAgent: s.userAgent,
      ...geoData(s.geo),
      expiresAt: this.idle(s.lastSeenAt, s.expiresAt),
      absoluteExpiresAt: s.expiresAt,
      lastSeenAt: s.lastSeenAt,
      createdAt: s.createdAt,
    };
  }
  async knownLocations(userId: string) {
    const rows = await this.db.session.findMany({
      where: { userId, geoCountryCode: { not: null } },
      distinct: ['geoCountryCode', 'geoRegion'],
      select: { geoCountryCode: true, geoRegion: true },
      take: 500,
    });
    return rows.map((r) => ({ countryCode: r.geoCountryCode!, region: r.geoRegion }));
  }
  async createWithOutbox(s: Session, e: NewLocationOutboxEvent) {
    // sessions is global; outbox_events is org-scoped (forced RLS), so the shared transaction runs in the event's org.
    const r = await withOrgContext(
      e.organizationId,
      async (tx) => {
        const row = await tx.session.create({ data: this.sessionData(s) });
        await tx.outboxEvent.create({
          data: {
            organizationId: e.organizationId,
            aggregateType: e.aggregateType,
            aggregateId: e.aggregateId,
            eventType: e.eventType,
            payload: { ...e.payload },
          },
        });
        return row;
      },
      { client: this.db },
    );
    return toSession(r);
  }
  async create(s: Session) {
    const r = await this.db.session.create({
      data: {
        id: s.id,
        userId: s.userId,
        tokenHash: s.tokenHash,
        activeOrgId: s.activeOrganizationId,
        ipAddress: s.ip,
        userAgent: s.userAgent,
        ...geoData(s.geo),
        expiresAt: this.idle(s.lastSeenAt, s.expiresAt),
        absoluteExpiresAt: s.expiresAt,
        lastSeenAt: s.lastSeenAt,
        createdAt: s.createdAt,
      },
    });
    return toSession(r);
  }
  async findByTokenHash(tokenHash: string) {
    const r = await this.db.session.findUnique({ where: { tokenHash } });
    return r ? toSession(r) : null;
  }
  async findById(id: string) {
    const r = await this.db.session.findUnique({ where: { id } });
    return r ? toSession(r) : null;
  }
  async findLastActiveOrganizationId(userId: string) {
    const r = await this.db.session.findFirst({
      where: { userId, activeOrgId: { not: null } },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      select: { activeOrgId: true },
    });
    return r?.activeOrgId ?? null;
  }
  async listActiveForUser(userId: string, now: Date) {
    const rows = await this.db.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map(toSession);
  }
  async touch(id: string, at: Date) {
    const s = await this.db.session.findUnique({
      where: { id },
      select: { absoluteExpiresAt: true },
    });
    if (!s) return;
    await this.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { lastSeenAt: at, expiresAt: this.idle(at, s.absoluteExpiresAt) },
    });
  }
  async updateIp(id: string, ip: string | null, geo: GeoFields) {
    await this.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { ipAddress: ip, ...geoData(geo) },
    });
  }
  async revoke(id: string, at: Date) {
    await this.db.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
  }
  async revokeAllForUser(userId: string, at: Date) {
    await this.db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at },
    });
  }
}
