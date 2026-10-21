import { createHash } from 'node:crypto';
import { ApprovalRequiredError, assertApproved, type WriteApproval } from './types.js';

export type WriteOperation = 'createIssue' | 'updateStatus';

/** Tenant scope every provider instance is bound to. */
export interface IntegrationContext {
  organizationId: string;
  integrationId: string;
}

export interface WriteContext extends IntegrationContext {
  operation: WriteOperation;
  provider: string;
  payloadHash: string;
}

/**
 * Implemented by Backend. Must check that approvalId exists, is approved, belongs to organizationId, targets this
 * integration/operation, has the same payloadHash, is unexpired and unused, and atomically consume it (single use).
 */
export interface ApprovalVerifier {
  verify(approval: WriteApproval, ctx: WriteContext): Promise<boolean>;
}

export type AuditPhase = 'attempt' | 'success' | 'failure' | 'rejected';

export interface AuditEvent {
  phase: AuditPhase;
  operation: WriteOperation;
  provider: string;
  organizationId: string;
  integrationId: string;
  payloadHash: string;
  approvalId?: string;
  approverUserId?: string;
  /** e.g. "owner/repo#12" / "PROJ-12" when known. */
  externalId?: string;
  /** Sanitized error name/message (no upstream bodies or secrets). */
  error?: string;
  at: string;
}

/** Implemented by Backend (append-only audit log). Failures to audit abort the write. */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

export type IntegrationCredentials =
  | { kind: 'github'; token: string }
  | { kind: 'jira'; email: string; apiToken: string }
  | { kind: 'jira-oauth'; accessToken: string };

/**
 * Implemented by Backend (secret manager / encrypted DB). Called right before each API use so tokens are never
 * held in provider config and can be rotated/refreshed.
 */
export interface CredentialResolver {
  resolve(organizationId: string, integrationId: string): Promise<IntegrationCredentials>;
}

export class ApprovalMismatchError extends ApprovalRequiredError {
  constructor(operation: string, detail: string) {
    super(operation, detail);
    this.name = 'ApprovalMismatchError';
  }
}

export class ApprovalRejectedError extends ApprovalRequiredError {
  constructor(operation: string) {
    super(operation, 'approval was rejected by the verifier');
    this.name = 'ApprovalRejectedError';
  }
}

/** Deterministic JSON: sorted object keys, undefined dropped, arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite number in payload');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 over the canonical {operation, provider, organizationId, integrationId, payload}. Backend must use this too. */
export function computeWritePayloadHash(
  operation: WriteOperation,
  scope: IntegrationContext & { provider: string },
  payload: unknown
): string {
  const doc = { operation, provider: scope.provider, organizationId: scope.organizationId, integrationId: scope.integrationId, payload };
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

export function sanitizeError(err: unknown): string {
  const e = err as { name?: unknown; status?: unknown };
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return typeof e?.status === 'number' ? `${name} (${e.status})` : name;
}

export interface WriteGuardDeps {
  approvals: ApprovalVerifier;
  audit: AuditSink;
  now?: () => Date;
}

/**
 * Enforces: approval shape -> org match -> payload hash match -> verifier -> audit(attempt) -> write -> audit(success|failure).
 * Nothing reaches the network unless every check passes.
 */
export async function guardedWrite<T>(
  deps: WriteGuardDeps,
  scope: IntegrationContext & { provider: string; operation: WriteOperation },
  payload: unknown,
  approval: unknown,
  write: () => Promise<T>,
  externalIdOf?: (r: T) => string | undefined
): Promise<T> {
  const op = `${scope.provider}.${scope.operation}`;
  const payloadHash = computeWritePayloadHash(scope.operation, scope, payload);
  const at = () => (deps.now ?? (() => new Date()))().toISOString();
  const base = { operation: scope.operation, provider: scope.provider, organizationId: scope.organizationId, integrationId: scope.integrationId, payloadHash };
  const reject = async (err: Error, a?: Partial<WriteApproval>) => {
    const ev: AuditEvent = { ...base, phase: 'rejected', error: err.name, at: at() };
    if (typeof a?.approvalId === 'string') ev.approvalId = a.approvalId;
    if (typeof a?.approverUserId === 'string') ev.approverUserId = a.approverUserId;
    await deps.audit.record(ev);
    throw err;
  };
  try {
    assertApproved(approval, op);
  } catch (err) {
    return reject(err as Error, (approval ?? undefined));
  }
  if (approval.organizationId !== scope.organizationId) return reject(new ApprovalMismatchError(op, 'approval belongs to another organization'), approval);
  if (approval.payloadHash !== payloadHash) return reject(new ApprovalMismatchError(op, 'approval payload hash does not match this write'), approval);
  const ok = await deps.approvals.verify(approval, { ...scope, payloadHash });
  if (!ok) return reject(new ApprovalRejectedError(op), approval);
  const who = { approvalId: approval.approvalId, approverUserId: approval.approverUserId };
  await deps.audit.record({ ...base, ...who, phase: 'attempt', at: at() });
  try {
    const result = await write();
    const ev: AuditEvent = { ...base, ...who, phase: 'success', at: at() };
    const ext = externalIdOf?.(result);
    if (ext) ev.externalId = ext;
    await deps.audit.record(ev);
    return result;
  } catch (err) {
    await deps.audit.record({ ...base, ...who, phase: 'failure', error: sanitizeError(err), at: at() });
    throw err;
  }
}
