import type { GeoFields } from '../../../shared/geoip/provider.js';
export type AuditAction =
  | 'auth.signup'
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.lockout'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'auth.session.revoke'
  | 'auth.password_reset.request'
  | 'auth.password_reset.complete'
  | 'auth.email.verify'
  | 'auth.email.verification_resend'
  /** OIDC review M-2 / N-4: a Google subject was linked to an existing account (distinct from a sign-in). */
  | 'auth.google.linked'
  // ADR-021 MFA (pre-tenant; mapped to record_global_auth_event names in prisma-audit.log.ts)
  | 'auth.mfa.enroll'
  | 'auth.mfa.confirm'
  | 'auth.mfa.disable'
  | 'auth.mfa.challenge.success'
  | 'auth.mfa.challenge.failure'
  | 'auth.mfa.step_up'
  | 'auth.mfa.recovery_code.used'
  | 'auth.mfa.recovery_codes.regenerate'
  | 'auth.mfa.lockout'
  | 'org.create'
  | 'org.switch'
  | 'invitation.create'
  | 'invitation.accepted'
  | 'invitation.revoke'
  | 'membership.role_change'
  | 'membership.remove'
  // BE-3 directory
  | 'employee.create'
  | 'employee.update'
  | 'employee.delete'
  | 'team.create'
  | 'team.update'
  | 'team.delete'
  | 'team_member.add'
  | 'team_member.update'
  | 'team_member.remove'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'extracted_task.accept'
  | 'extracted_task.dismiss'
  | 'task.create'
  | 'task.update'
  | 'meeting.create'
  // ADR-005 extension pairing and tokens
  | 'extension.pair'
  | 'extension.token.issue'
  | 'extension.token.refresh'
  | 'extension.token.reuse_detected'
  | 'extension.token.delisted'
  | 'extension.revoke'
  // ADR-012 desktop sign-in (behind DESKTOP_AUTH_ENABLED)
  | 'desktop.authorize'
  | 'desktop.token.issue'
  | 'desktop.token.refresh'
  | 'desktop.token.reuse_detected'
  | 'desktop.revoke'
  | 'desktop.org_switch'
  // Phase 5 (ADR-008) integrations
  | 'integration.disconnect'
  | 'integration.connect'
  | 'integration.issue_push'
  | 'integration.task_sync_requested'
  // Phase 7 calendar (self-service, per user)
  | 'calendar.connect'
  | 'calendar.disconnect'
  | 'calendar.link'
  | 'calendar.unlink';

/** Never put passwords, tokens, cookies or hashes in metadata. */
export interface AuditEvent {
  /** Null for pre-tenant events (signup, login). */
  organizationId: string | null;
  actorId: string | null;
  action: AuditAction;
  targetType:
    | 'user'
    | 'session'
    | 'organization'
    | 'invitation'
    | 'membership'
    | 'employee'
    | 'team'
    | 'team_member'
    | 'project'
    | 'extracted_task'
    | 'task'
    | 'meeting'
    | 'extension_device'
    | 'desktop_device'
    | 'integration'
    | 'calendar_connection'
    | 'mfa_factor';
  targetId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ip: string | null;
  userAgent: string | null;
  /** ADR-014 coarse GeoIP of `ip`. */
  geo?: GeoFields;
}

export interface AuditLog {
  record(e: AuditEvent): Promise<void>;
}

export class InMemoryAuditLog implements AuditLog {
  readonly events: (AuditEvent & { at: Date })[] = [];
  async record(e: AuditEvent) {
    this.events.push({ ...e, at: new Date() });
  }
}

/** Auditing must never break the request it describes. */
export async function safeAudit(log: AuditLog, e: AuditEvent): Promise<void> {
  try {
    await log.record(e);
  } catch {
    // swallowed on purpose; adapters report their own failures
  }
}
