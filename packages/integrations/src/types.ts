export type IssueStatus = 'open' | 'in_progress' | 'done' | 'closed';

export interface CreateIssueInput {
  title: string;
  description?: string;
  labels?: string[];
  assignees?: string[];
  /** Provider-specific target, e.g. "owner/repo" for GitHub or project key for Jira. Falls back to adapter default. */
  project?: string;
  /** Opaque MeetOps reference (task/meeting id) for traceability. */
  externalRef?: string;
}

export interface Issue {
  provider: string;
  /** Provider-scoped unique key, e.g. "owner/repo#12" or "PROJ-12". */
  key: string;
  id: string;
  title: string;
  status: IssueStatus;
  url: string;
  assignees: string[];
  labels: string[];
  updatedAt?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  provider: string;
  message?: string;
}

/**
 * Reference to a human approval recorded by Backend for one specific write.
 * Verified via an injected ApprovalVerifier; payloadHash must equal computeWritePayloadHash(...) of the exact write.
 */
export interface WriteApproval {
  approvalId: string;
  organizationId: string;
  approverUserId: string;
  /** sha256 hex of the canonical write payload. */
  payloadHash: string;
}

export class ApprovalRequiredError extends Error {
  constructor(operation: string, detail = 'requires an approval reference') {
    super(`${operation} ${detail}`);
    this.name = 'ApprovalRequiredError';
  }
}

/** Throws ApprovalRequiredError unless the approval reference is structurally complete. */
export function assertApproved(approval: unknown, operation: string): asserts approval is WriteApproval {
  const a = approval as Partial<Record<keyof WriteApproval, unknown>> | null | undefined;
  const ok =
    typeof a === 'object' &&
    a !== null &&
    (['approvalId', 'organizationId', 'approverUserId'] as const).every((k) => typeof a[k] === 'string' && (a[k]).length > 0) &&
    typeof a.payloadHash === 'string' &&
    /^[0-9a-f]{64}$/.test(a.payloadHash);
  if (!ok) throw new ApprovalRequiredError(operation);
}

export interface IssueTrackerProvider {
  readonly name: string;
  /** Outbound write: requires a verified approval; throws before any network call otherwise. */
  createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue>;
  /** Outbound write: requires a verified approval; throws before any network call otherwise. */
  updateStatus(key: string, status: IssueStatus, approval: WriteApproval): Promise<Issue>;
  getIssue(key: string): Promise<Issue | null>;
  healthCheck(): Promise<HealthCheckResult>;
}

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export class IssueTrackerError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'IssueTrackerError';
  }
}
