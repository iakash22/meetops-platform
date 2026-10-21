export type ProviderConfigAuditEvent = {
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'approve' | 'revoke' | 'override';
  tenantId: string | null;
  actorId: string;
  provider?: string | undefined;
  feature?: string | undefined;
  /** Redacted before/after; never contains secrets. */
  before?: unknown;
  after?: unknown;
  at: string;
};

export interface AuditSink {
  emit(e: ProviderConfigAuditEvent): Promise<void> | void;
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: ProviderConfigAuditEvent[] = [];
  emit(e: ProviderConfigAuditEvent) {
    this.events.push(e);
  }
}

const SECRET_KEYS = /key|secret|token|password|credential/i;
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : redact(x)]));
  return v;
}
