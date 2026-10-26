import { getPrismaClient, withOrganizationContext, type DatabaseClient } from '@meetops/database';
import type { MembershipRecord, SessionRecord, SessionStore } from './types.js';

/**
 * SessionStore over @meetops/database. `sessions` and `users` are global tables; the membership read runs
 * under withOrganizationContext so forced RLS only exposes the session's own organization (ADR-011 2.3).
 * Read-only: nothing here writes, so verification never slides last_seen_at (ADR-011 2.5).
 */
export function createPrismaSessionStore(client?: DatabaseClient): SessionStore {
  const db = () => client ?? getPrismaClient();
  return {
    async findSessionByTokenHash(tokenHash): Promise<SessionRecord | null> {
      const s = await db().session.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          activeOrgId: true,
          expiresAt: true,
          absoluteExpiresAt: true,
          lastSeenAt: true,
          revokedAt: true,
          user: { select: { deletedAt: true } },
        },
      });
      if (!s) return null;
      return {
        id: s.id,
        userId: s.userId,
        activeOrganizationId: s.activeOrgId,
        idleExpiresAt: s.expiresAt,
        absoluteExpiresAt: s.absoluteExpiresAt,
        lastSeenAt: s.lastSeenAt,
        revokedAt: s.revokedAt,
        userDeletedAt: s.user.deletedAt,
      };
    },
    async findMembership(organizationId, userId): Promise<MembershipRecord | null> {
      return withOrganizationContext(
        organizationId,
        (tx) =>
          tx.membership.findFirst({
            where: { organizationId, userId, deletedAt: null },
            select: { role: true, deletedAt: true },
          }),
        { client: db(), userId },
      );
    },
  };
}
