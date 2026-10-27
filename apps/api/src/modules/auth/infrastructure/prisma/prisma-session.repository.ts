import { getPrismaClient, type DatabaseClient } from '../../../../shared/prisma/context.js';
import type { Session, SessionRepository } from '../../domain/session.js';

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
  async create(s: Session) {
    const r = await this.db.session.create({
      data: {
        id: s.id,
        userId: s.userId,
        tokenHash: s.tokenHash,
        activeOrgId: s.activeOrganizationId,
        ipAddress: s.ip,
        userAgent: s.userAgent,
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
