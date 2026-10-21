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

export interface IssueTrackerProvider {
  readonly name: string;
  createIssue(input: CreateIssueInput): Promise<Issue>;
  updateStatus(key: string, status: IssueStatus): Promise<Issue>;
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
