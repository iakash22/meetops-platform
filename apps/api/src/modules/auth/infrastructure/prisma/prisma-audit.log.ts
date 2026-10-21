import { getPrismaClient, withOrgContext, type DatabaseClient } from '../../../../shared/prisma/context.js';
import type { AuditEvent, AuditLog } from '../../domain/audit.js';

/**
 * Org-scoped events → audit_events inside withOrgContext. Pre-tenant events (signup, login,
 * resets: organizationId null) go to `fallback` because audit_events.org_id is still NOT NULL.
 * TODO(database P1-DB-3): nullable audit_events.org_id, then write them here too.
 */
export class PrismaAuditLog implements AuditLog {
  constructor(
    private readonly fallback: AuditLog,
    private readonly db: DatabaseClient = getPrismaClient()
  ) {}
  async record(e: AuditEvent) {
    if (!e.organizationId) return this.fallback.record(e);
    const orgId = e.organizationId;
    await withOrgContext(
      orgId,
      (tx) =>
        tx.auditEvent.create({
          data: {
            orgId,
            actorId: e.actorId,
            action: e.action,
            targetType: e.targetType,
            targetId: e.targetId,
            metadata: e.metadata,
            ipAddress: e.ip,
            userAgent: e.userAgent
          }
        }),
      { client: this.db }
    );
  }
}

/** Structured-log audit sink (no secrets ever reach AuditEvent). */
export class LoggerAuditLog implements AuditLog {
  constructor(private readonly log: { info(obj: object, msg: string): void }) {}
  async record(e: AuditEvent) {
    this.log.info({ audit: e }, 'audit');
  }
}
