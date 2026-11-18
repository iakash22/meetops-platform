import {
  getPrismaClient,
  withOrgContext,
  type DatabaseClient,
} from '../../../../shared/prisma/context.js';
import type { AuditAction, AuditEvent, AuditLog } from '../../domain/audit.js';
import { truncateIp } from '../../../../shared/geoip/ip.js';

/**
 * API action -> the allowlist in public.record_global_auth_event (migration 20261022032000, geo args added in
 * 20261028010000, auth.google_linked added in 20261109120000). Lockout is recorded as a failed login with `metadata.lockout = true`.
 */
const GLOBAL_AUTH_ACTIONS: Partial<Record<AuditAction, string>> = {
  'auth.signup': 'auth.signup',
  'auth.login.success': 'auth.login_succeeded',
  'auth.login.failure': 'auth.login_failed',
  'auth.lockout': 'auth.login_failed',
  'auth.logout': 'auth.logout',
  'auth.logout_all': 'auth.logout',
  'auth.session.revoke': 'auth.session_revoked',
  'auth.password_reset.request': 'auth.password_reset_requested',
  'auth.password_reset.complete': 'auth.password_reset_completed',
  'auth.email.verify': 'auth.email_verified',
  'auth.email.verification_resend': 'auth.email_verification_sent',
  'auth.google.linked': 'auth.google_linked',
};
const GLOBAL_TARGET_TYPES = new Set(['user', 'session', 'email']);

export class UnmappedGlobalAuditError extends Error {
  constructor(readonly action: string) {
    super('global audit action not allowed');
    this.name = 'UnmappedGlobalAuditError';
  }
}

/**
 * audit_events (DB #35): org events are written inside withOrgContext with createMany (Prisma `create` needs
 * RETURNING, which RLS refuses for rows the app cannot SELECT). Pre-tenant events (organizationId null: signup,
 * login, resets) go through the SECURITY DEFINER `record_global_auth_event`, because the audit_insert policy
 * rejects org_id NULL from meetops_app (#290 M-2: a direct insert was silently dropped by safeAudit).
 */
export class PrismaAuditLog implements AuditLog {
  constructor(
    private readonly db: DatabaseClient = getPrismaClient(),
    private readonly log?: { warn(obj: object, msg: string): void },
  ) {}
  async record(e: AuditEvent) {
    if (!e.organizationId) {
      try {
        await this.recordGlobal(e);
      } catch (err) {
        // safeAudit swallows; report action + error name only (never IP, metadata or message text).
        this.log?.warn(
          { action: e.action, errName: err instanceof Error ? err.name : 'unknown' },
          'global audit event not recorded',
        );
        throw err;
      }
      return;
    }
    const data = {
      organizationId: e.organizationId,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      metadata: e.metadata,
      ipAddress: e.ip,
      userAgent: e.userAgent,
      geoCity: e.geo?.geoCity ?? null,
      geoRegion: e.geo?.geoRegion ?? null,
      geoCountry: e.geo?.geoCountry ?? null,
      geoCountryCode: e.geo?.geoCountryCode ?? null,
      geoApproximate: e.geo?.geoApproximate ?? null,
    };
    await withOrgContext(e.organizationId, (tx) => tx.auditEvent.createMany({ data: [data] }), {
      client: this.db,
    });
  }

  private async recordGlobal(e: AuditEvent) {
    const action = GLOBAL_AUTH_ACTIONS[e.action];
    if (!action || !GLOBAL_TARGET_TYPES.has(e.targetType))
      throw new UnmappedGlobalAuditError(e.action);
    const metadata = JSON.stringify(
      e.action === 'auth.lockout' ? { ...e.metadata, lockout: true } : e.metadata,
    );
    await this.db.$executeRaw`SELECT public.record_global_auth_event(
      ${action}::text, ${e.actorId}::uuid, ${e.targetType}::text, ${e.targetId}::text, ${metadata}::jsonb,
      ${e.ip}::text, ${e.userAgent}::text, ${e.geo?.geoCity ?? null}::text, ${e.geo?.geoRegion ?? null}::text,
      ${e.geo?.geoCountry ?? null}::text, ${e.geo?.geoCountryCode ?? null}::text)`;
  }
}

/** Structured-log audit sink (no secrets ever reach AuditEvent). */
export class LoggerAuditLog implements AuditLog {
  constructor(private readonly log: { info(obj: object, msg: string): void }) {}
  async record(e: AuditEvent) {
    // ADR-014: never a full IP at info level.
    this.log.info({ audit: { ...e, ip: truncateIp(e.ip) } }, 'audit');
  }
}
