import {
  assertApproved,
  IssueTrackerError,
  type CreateIssueInput,
  type HealthCheckResult,
  type Issue,
  type IssueStatus,
  type IssueTrackerProvider,
  type WriteApproval
} from './types.js';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface JiraOptions {
  /** https://<site>.atlassian.net */
  baseUrl: string;
  email: string;
  /** Atlassian API token. Never logged. */
  apiToken: string;
  /** Default project key, e.g. "MEET". */
  projectKey?: string;
  issueType?: string;
  /** Internal status -> Jira transition name (case-insensitive). */
  transitions?: Partial<Record<IssueStatus, string>>;
  fetch?: FetchLike;
}

export const DEFAULT_JIRA_TRANSITIONS: Record<IssueStatus, string> = {
  open: 'To Do',
  in_progress: 'In Progress',
  done: 'Done',
  closed: "Won't Do"
};

interface JiraIssueData {
  id: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: { accountId?: string; displayName?: string } | null;
    labels?: string[];
    updated?: string;
    resolution?: { name?: string } | null;
  };
}

/** Plain text -> minimal Atlassian Document Format. */
export function toAdf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text.split(/\n{2,}/).map((para) => ({
      type: 'paragraph',
      content: para ? [{ type: 'text', text: para }] : []
    }))
  };
}

export function validateJiraBaseUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new IssueTrackerError('Invalid Jira base URL', 'jira');
  }
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.atlassian\.net$/i.test(u.hostname)) {
    throw new IssueTrackerError('Jira base URL must be https://<site>.atlassian.net', 'jira');
  }
  return u.origin;
}

export class JiraIssueTrackerProvider implements IssueTrackerProvider {
  readonly name = 'jira';
  private readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly authHeader: string;
  private readonly transitions: Record<IssueStatus, string>;

  constructor(private readonly options: JiraOptions) {
    this.base = validateJiraBaseUrl(options.baseUrl);
    if (!options.email || !options.apiToken) throw new IssueTrackerError('Jira email and API token are required', 'jira');
    this.authHeader = 'Basic ' + Buffer.from(`${options.email}:${options.apiToken}`).toString('base64');
    this.fetchFn = options.fetch ?? (globalThis.fetch);
    this.transitions = { ...DEFAULT_JIRA_TRANSITIONS, ...options.transitions };
  }

  async createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue> {
    assertApproved(approval, 'jira.createIssue');
    const project = input.project ?? this.options.projectKey;
    if (!project) throw new IssueTrackerError('No Jira project key specified', this.name);
    const desc = [input.description, input.externalRef ? `MeetOps ref: ${input.externalRef}` : undefined].filter(Boolean).join('\n\n');
    const fields: Record<string, unknown> = {
      project: { key: project },
      summary: input.title,
      issuetype: { name: this.options.issueType ?? 'Task' }
    };
    if (desc) fields.description = toAdf(desc);
    if (input.labels?.length) fields.labels = input.labels.map((l) => l.replace(/\s+/g, '-'));
    // Jira Cloud assigns by accountId; first assignee only.
    if (input.assignees?.[0]) fields.assignee = { accountId: input.assignees[0] };
    const created = (await this.request('POST', '/rest/api/3/issue', { fields })) as { key: string };
    const issue = await this.getIssue(created.key);
    if (!issue) throw new IssueTrackerError(`Created issue ${created.key} not found`, this.name);
    return issue;
  }

  async getIssue(key: string): Promise<Issue | null> {
    const res = await this.raw('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,labels,updated,resolution`);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.httpError(res);
    return this.toIssue((await res.json()) as JiraIssueData);
  }

  async updateStatus(key: string, status: IssueStatus, approval: WriteApproval): Promise<Issue> {
    assertApproved(approval, 'jira.updateStatus');
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
    const wanted = this.transitions[status].toLowerCase();
    const { transitions } = (await this.request('GET', path)) as { transitions?: { id: string; name: string; to?: { name?: string } }[] };
    const t = (transitions ?? []).find((x) => x.name.toLowerCase() === wanted || x.to?.name?.toLowerCase() === wanted);
    if (!t) throw new IssueTrackerError(`No Jira transition "${this.transitions[status]}" available for ${key}`, this.name);
    await this.request('POST', path, { transition: { id: t.id } });
    const issue = await this.getIssue(key);
    if (!issue) throw new IssueTrackerError(`Issue ${key} not found after transition`, this.name, 404);
    return issue;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      await this.request('GET', '/rest/api/3/myself');
      return { ok: true, provider: this.name };
    } catch (err) {
      return { ok: false, provider: this.name, message: (err as Error).message };
    }
  }

  private toIssue(d: JiraIssueData): Issue {
    const f = d.fields ?? {};
    const cat = f.status?.statusCategory?.key;
    let status: IssueStatus = 'open';
    if (cat === 'indeterminate') status = 'in_progress';
    else if (cat === 'done') status = /won'?t|not planned|cancel|declin|duplicate/i.test(`${f.resolution?.name ?? ''} ${f.status?.name ?? ''}`) ? 'closed' : 'done';
    const issue: Issue = {
      provider: this.name,
      key: d.key,
      id: d.id,
      title: f.summary ?? '',
      status,
      url: `${this.base}/browse/${d.key}`,
      assignees: f.assignee?.accountId ? [f.assignee.accountId] : [],
      labels: f.labels ?? []
    };
    if (f.updated) issue.updatedAt = f.updated;
    return issue;
  }

  private async raw(method: string, path: string, body?: unknown) {
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers: { Authorization: this.authHeader, Accept: 'application/json' }
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    try {
      return await this.fetchFn(`${this.base}${path}`, init);
    } catch (err) {
      throw new IssueTrackerError(`Jira request failed: ${(err as Error).message}`, this.name);
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.raw(method, path, body);
    if (!res.ok) throw await this.httpError(res);
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  private async httpError(res: { status: number; text(): Promise<string> }) {
    let detail = '';
    try {
      const j = JSON.parse(await res.text()) as { errorMessages?: string[]; errors?: Record<string, string> };
      detail = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join('; ');
    } catch {
      /* ignore */
    }
    return new IssueTrackerError(`Jira request failed (${res.status})${detail ? `: ${detail}` : ''}`, this.name, res.status);
  }
}
