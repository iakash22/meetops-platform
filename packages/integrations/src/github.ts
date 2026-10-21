import { Octokit } from '@octokit/rest';
import { guardedWrite, type ApprovalVerifier, type AuditSink, type CredentialResolver, type IntegrationContext } from './governance.js';
import { IssueTrackerError, type WriteApproval, type CreateIssueInput, type HealthCheckResult, type Issue, type IssueStatus, type IssueTrackerProvider } from './types.js';

/** Minimal Octokit surface used by the adapter; inject a mock in tests. */
export interface GitHubIssuesClient {
  rest: {
    issues: {
      create(params: { owner: string; repo: string; title: string; body?: string; labels?: string[]; assignees?: string[] }): Promise<{ data: GitHubIssueData }>;
      get(params: { owner: string; repo: string; issue_number: number }): Promise<{ data: GitHubIssueData }>;
      update(params: { owner: string; repo: string; issue_number: number; state?: 'open' | 'closed'; state_reason?: 'completed' | 'not_planned' | 'reopened'; labels?: string[] }): Promise<{ data: GitHubIssueData }>;
    };
    repos: { get(params: { owner: string; repo: string }): Promise<{ data: { full_name: string } }> };
  };
}

export interface GitHubIssueData {
  id: number;
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  html_url: string;
  updated_at?: string;
  assignees?: ({ login: string } | null)[] | null;
  labels?: (string | { name?: string | null })[];
}

export interface GitHubIssuesOptions extends IntegrationContext {
  /** Resolves the token right before each API call (no plaintext token in config). */
  credentials: CredentialResolver;
  approvals: ApprovalVerifier;
  audit: AuditSink;
  /** Default "owner/repo". */
  defaultRepo?: string;
  /** Label applied for in_progress status (GitHub has no native state). */
  inProgressLabel?: string;
  /** Builds a client for a resolved token. Default: new Octokit({ auth: token }). Inject a mock in tests. */
  clientFactory?: (token: string) => GitHubIssuesClient;
}

export const DEFAULT_IN_PROGRESS_LABEL = 'status: in-progress';

export function parseRepo(repo: string): { owner: string; repo: string } {
  const [owner, name, ...rest] = repo.split('/');
  if (!owner || !name || rest.length) throw new IssueTrackerError(`Invalid repo "${repo}", expected owner/repo`, 'github');
  return { owner, repo: name };
}

/** Parses "owner/repo#123" (or "#123"/"123" with defaultRepo). */
export function parseIssueKey(key: string, defaultRepo?: string): { owner: string; repo: string; issue_number: number } {
  const m = /^(?:([^/#\s]+\/[^/#\s]+))?#?(\d+)$/.exec(key.trim());
  const repo = m?.[1] ?? defaultRepo;
  if (!m?.[2] || !repo) throw new IssueTrackerError(`Invalid GitHub issue key "${key}"`, 'github');
  return { ...parseRepo(repo), issue_number: Number(m[2]) };
}

export class GitHubIssuesProvider implements IssueTrackerProvider {
  readonly name = 'github';
  private readonly inProgressLabel: string;
  private readonly clientFactory: (token: string) => GitHubIssuesClient;

  constructor(private readonly options: GitHubIssuesOptions) {
    this.inProgressLabel = options.inProgressLabel ?? DEFAULT_IN_PROGRESS_LABEL;
    this.clientFactory = options.clientFactory ?? ((token) => new Octokit({ auth: token }));
  }

  /** Resolves credentials immediately before use; never cached on the instance. */
  private async client(): Promise<GitHubIssuesClient> {
    const cred = await this.options.credentials.resolve(this.options.organizationId, this.options.integrationId);
    if (cred.kind !== 'github' || !cred.token) throw new IssueTrackerError('GitHub credentials unavailable', this.name);
    return this.clientFactory(cred.token);
  }

  private scope(operation: 'createIssue' | 'updateStatus') {
    return { provider: this.name, operation, organizationId: this.options.organizationId, integrationId: this.options.integrationId };
  }

  /** Hash payload is exactly the input passed (Backend hashes the same object at approval time). */
  async createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue> {
    return guardedWrite(this.options, this.scope('createIssue'), input, approval, () => this.doCreate(input), (i) => i.key);
  }

  /** Hash payload: { key, status }. */
  async updateStatus(key: string, status: IssueStatus, approval: WriteApproval): Promise<Issue> {
    return guardedWrite(this.options, this.scope('updateStatus'), { key, status }, approval, () => this.doUpdate(key, status), (i) => i.key);
  }

  private async doCreate(input: CreateIssueInput): Promise<Issue> {
    const repoRef = input.project ?? this.options.defaultRepo;
    if (!repoRef) throw new IssueTrackerError('No repository specified', this.name);
    const { owner, repo } = parseRepo(repoRef);
    const body = [input.description, input.externalRef ? `\n<!-- meetops-ref: ${input.externalRef} -->` : undefined].filter(Boolean).join('\n');
    const params: Parameters<GitHubIssuesClient['rest']['issues']['create']>[0] = { owner, repo, title: input.title };
    if (body) params.body = body;
    if (input.labels?.length) params.labels = input.labels;
    if (input.assignees?.length) params.assignees = input.assignees;
    const client = await this.client();
    const { data } = await this.wrap(() => client.rest.issues.create(params));
    return this.toIssue(owner, repo, data);
  }

  async getIssue(key: string): Promise<Issue | null> {
    const ref = parseIssueKey(key, this.options.defaultRepo);
    try {
      const client = await this.client();
      const { data } = await client.rest.issues.get(ref);
      return this.toIssue(ref.owner, ref.repo, data);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw this.toError(err);
    }
  }

  private async doUpdate(key: string, status: IssueStatus): Promise<Issue> {
    const client = await this.client();
    const ref = parseIssueKey(key, this.options.defaultRepo);
    const { data: current } = await this.wrap(() => client.rest.issues.get(ref));
    const labels = labelNames(current).filter((l) => l !== this.inProgressLabel);
    const update: Parameters<GitHubIssuesClient['rest']['issues']['update']>[0] = { ...ref };
    switch (status) {
      case 'open':
        update.state = 'open';
        update.labels = labels;
        if (current.state === 'closed') update.state_reason = 'reopened';
        break;
      case 'in_progress':
        update.state = 'open';
        update.labels = [...labels, this.inProgressLabel];
        break;
      case 'done':
        update.state = 'closed';
        update.state_reason = 'completed';
        update.labels = labels;
        break;
      case 'closed':
        update.state = 'closed';
        update.state_reason = 'not_planned';
        update.labels = labels;
        break;
    }
    const { data } = await this.wrap(() => client.rest.issues.update(update));
    return this.toIssue(ref.owner, ref.repo, data);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this.options.defaultRepo) return { ok: true, provider: this.name, message: 'client configured (no default repo to probe)' };
    try {
      const client = await this.client();
      await client.rest.repos.get(parseRepo(this.options.defaultRepo));
      return { ok: true, provider: this.name };
    } catch (err) {
      return { ok: false, provider: this.name, message: this.toError(err).message };
    }
  }

  private toIssue(owner: string, repo: string, d: GitHubIssueData): Issue {
    const labels = labelNames(d);
    let status: IssueStatus = 'open';
    if (d.state === 'closed') status = d.state_reason === 'not_planned' ? 'closed' : 'done';
    else if (labels.includes(this.inProgressLabel)) status = 'in_progress';
    const issue: Issue = {
      provider: this.name,
      key: `${owner}/${repo}#${d.number}`,
      id: String(d.id),
      title: d.title,
      status,
      url: d.html_url,
      assignees: (d.assignees ?? []).flatMap((a) => (a ? [a.login] : [])),
      labels
    };
    if (d.updated_at) issue.updatedAt = d.updated_at;
    return issue;
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.toError(err);
    }
  }

  private toError(err: unknown): IssueTrackerError {
    if (err instanceof IssueTrackerError) return err;
    // Sanitized: never include upstream messages/bodies/headers (may echo tokens or private data).
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number'
      ? new IssueTrackerError(`GitHub request failed (${status})`, this.name, status)
      : new IssueTrackerError('GitHub request failed', this.name);
  }
}

function labelNames(d: GitHubIssueData): string[] {
  return (d.labels ?? []).flatMap((l) => (typeof l === 'string' ? [l] : l.name ? [l.name] : []));
}
