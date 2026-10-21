import { getPrismaClient, withOrgContext, type DatabaseClient } from '../../../../shared/prisma/context.js';
import type { AuditEvent, AuditLog } from '../../domain/audit.js';

/**
 * audit_events (DB #35): org events are written inside withOrgContext; pre-tenant events
 * (organizationId null: signup, login, resets) are global rows that the app role may insert but
 * not read back. Both use createMany, because Prisma `create` needs RETURNING, which RLS refuses
 * for rows the app cannot SELECT.
 */
export class PrismaAuditLog implements AuditLog {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}
  async record(e: AuditEvent) {
    const data = {
      orgId: e.organizationId,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      metadata: e.metadata,
      ipAddress: e.ip,
      userAgent: e.userAgent
    };
    if (!e.organizationId) {
      await this.db.auditEvent.createMany({ data: [data] });
      return;
    }
    await withOrgContext(e.organizationId, (tx) => tx.auditEvent.createMany({ data: [data] }), { client: this.db });
  }
}

/** Structured-log audit sink (no secrets ever reach AuditEvent). */
export class LoggerAuditLog implements AuditLog {
  constructor(private readonly log: { info(obj: object, msg: string): void }) {}
  async record(e: AuditEvent) {
    this.log.info({ audit: e }, 'audit');
  }
}
