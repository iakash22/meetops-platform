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
 * Explicit human/system approval required for every outbound write.
 * There is intentionally no default: callers must pass `{ approved: true }`.
 */
export interface WriteApproval {
  approved: true;
  /** Who approved (user id/email) for audit logs. */
  approvedBy?: string;
  reason?: string;
}

export class ApprovalRequiredError extends Error {
  constructor(operation: string) {
    super(`${operation} requires explicit approval ({ approved: true })`);
    this.name = 'ApprovalRequiredError';
  }
}

/** Throws ApprovalRequiredError unless approval.approved === true (strict boolean). */
export function assertApproved(approval: unknown, operation: string): asserts approval is WriteApproval {
  if (
    typeof approval !== 'object' ||
    approval === null ||
    (approval as { approved?: unknown }).approved !== true
  ) {
    throw new ApprovalRequiredError(operation);
  }
}

export interface IssueTrackerProvider {
  readonly name: string;
  /** Outbound write: requires approval; throws ApprovalRequiredError before any network call otherwise. */
  createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue>;
  /** Outbound write: requires approval; throws ApprovalRequiredError before any network call otherwise. */
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
