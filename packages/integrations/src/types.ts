import { Value } from '@sinclair/typebox/value';
import { WriteApproval as WriteApprovalSchema, type IntegrationProvider, type IssueStatus, type WriteApproval } from '@meetops/contracts';

/** open | in_progress | done | closed — from @meetops/contracts. */
export type { IssueStatus, WriteApproval };

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
  provider: IntegrationProvider;
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

export class ApprovalRequiredError extends Error {
  constructor(operation: string, detail = 'requires an approval reference') {
    super(`${operation} ${detail}`);
    this.name = 'ApprovalRequiredError';
  }
}

/**
 * Throws ApprovalRequiredError unless the approval matches the contracts WriteApproval schema exactly:
 * { approvalId, organizationId, approverUserId (uuids), payloadHash (lowercase sha256 hex), approvedAt? }.
 */
export function assertApproved(approval: unknown, operation: string): asserts approval is WriteApproval {
  if (!Value.Check(WriteApprovalSchema, approval)) throw new ApprovalRequiredError(operation);
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
