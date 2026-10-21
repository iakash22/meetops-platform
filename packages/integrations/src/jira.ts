import { NotImplementedError, type HealthCheckResult, type Issue, type IssueTrackerProvider } from './types.js';

export interface JiraOptions {
  baseUrl?: string;
  projectKey?: string;
}

/** Placeholder Jira provider. All operations throw NotImplementedError until implemented. */
export class JiraIssueTrackerProvider implements IssueTrackerProvider {
  readonly name = 'jira';
  constructor(readonly options: JiraOptions = {}) {}

  async createIssue(): Promise<Issue> {
    throw new NotImplementedError('Jira createIssue');
  }
  async updateStatus(): Promise<Issue> {
    throw new NotImplementedError('Jira updateStatus');
  }
  async getIssue(): Promise<Issue | null> {
    throw new NotImplementedError('Jira getIssue');
  }
  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: false, provider: this.name, message: 'Jira integration not implemented' };
  }
}
