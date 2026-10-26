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
  | 'meeting.create';

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
    | 'meeting';
  targetId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ip: string | null;
  userAgent: string | null;
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
