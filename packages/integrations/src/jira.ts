import { guardedWrite, type ApprovalVerifier, type AuditSink, type CredentialResolver, type IntegrationContext, type WriteAttemptTracker } from './governance.js';
import {
  IssueTrackerError,
  type CreateIssueInput,
  type HealthCheckResult,
  type Issue,
  type IssueStatus,
  type IssueTrackerProvider,
  type WriteApproval
} from './types.js';
import { classifyHttpError, isIdempotentMethod, withRetry, type RetryOptions } from './retry.js';

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'error' | 'manual' | 'follow';
}

export type FetchLike = (url: string, init?: SafeFetchInit) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface JiraOptions extends IntegrationContext {
  /** https://<site>.atlassian.net, or https://api.atlassian.com/ex/jira/<cloudId> for scoped API tokens / OAuth. */
  baseUrl: string;
  /** Human-facing https://<site>.atlassian.net for browse links when baseUrl is the API gateway. */
  siteUrl?: string;
  /** Resolves email+API token (or OAuth access token) right before each request. */
  credentials: CredentialResolver;
  approvals: ApprovalVerifier;
  audit: AuditSink;
  /** Default project key, e.g. "MEET". */
  projectKey?: string;
  issueType?: string;
  /** Internal status -> Jira transition name (case-insensitive). */
  transitions?: Partial<Record<IssueStatus, string>>;
  fetch?: FetchLike;
  /** Per-request timeout. Default 10s. */
  timeoutMs?: number;
  /** Max response body size. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Retry policy (429 w/ Retry-After, 5xx, network/timeout). Other 4xx are never retried. */
  retry?: RetryOptions;
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
  if (u.protocol === 'https:' && /^[a-z0-9-]+\.atlassian\.net$/i.test(u.hostname)) return u.origin;
  // Scoped API tokens / OAuth must use the API gateway: https://api.atlassian.com/ex/jira/{cloudId}
  const gw = /^\/ex\/jira\/([0-9a-f-]{8,64})\/?$/i.exec(u.pathname);
  if (u.protocol === 'https:' && u.hostname === 'api.atlassian.com' && gw?.[1]) return `${u.origin}/ex/jira/${gw[1]}`;
  throw new IssueTrackerError('Jira base URL must be https://<site>.atlassian.net or https://api.atlassian.com/ex/jira/<cloudId>', 'jira');
}

interface JiraResponse {
  ok: boolean;
  status: number;
  body: string;
  header: (name: string) => string | undefined;
}

class RetryableJiraResponse extends Error {
  constructor(readonly res: JiraResponse) {
    super(`retryable ${res.status}`);
  }
}

export class JiraIssueTrackerProvider implements IssueTrackerProvider {
  readonly name = 'jira';
  private readonly base: string;
  private readonly siteBase: string;
  private readonly fetchFn: FetchLike;
  private readonly transitions: Record<IssueStatus, string>;

  constructor(private readonly options: JiraOptions) {
    this.base = validateJiraBaseUrl(options.baseUrl);
    this.siteBase = options.siteUrl ? validateJiraBaseUrl(options.siteUrl) : this.base;
    this.fetchFn = options.fetch ?? (globalThis.fetch);
    this.transitions = { ...DEFAULT_JIRA_TRANSITIONS, ...options.transitions };
  }

  private scope(operation: 'createIssue' | 'updateStatus') {
    return { provider: this.name, operation, organizationId: this.options.organizationId, integrationId: this.options.integrationId };
  }

  /** Hash payload is exactly the input passed. */
  async createIssue(input: CreateIssueInput, approval: WriteApproval): Promise<Issue> {
    return guardedWrite(this.options, this.scope('createIssue'), input, approval, (t) => this.doCreate(input, t), (i) => i.key);
  }

  /** Hash payload: { key, status }. */
  async updateStatus(key: string, status: IssueStatus, approval: WriteApproval): Promise<Issue> {
    return guardedWrite(this.options, this.scope('updateStatus'), { key, status }, approval, (t) => this.doUpdate(key, status, t), (i) => i.key);
  }

  private async doCreate(input: CreateIssueInput, tracker?: WriteAttemptTracker): Promise<Issue> {
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
    const created = (await this.request('POST', '/rest/api/3/issue', { fields }, tracker)) as { key: string };
    const issue = await this.getIssue(created.key);
    if (!issue) throw new IssueTrackerError(`Created issue ${created.key} not found`, this.name);
    return issue;
  }

  async getIssue(key: string): Promise<Issue | null> {
    const res = await this.raw('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,labels,updated,resolution`);
    if (res.status === 404) return null;
    if (!res.ok) throw this.httpError(res.status);
    return this.toIssue(JSON.parse(res.body) as JiraIssueData);
  }

  private async doUpdate(key: string, status: IssueStatus, tracker?: WriteAttemptTracker): Promise<Issue> {
    const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
    const wanted = this.transitions[status].toLowerCase();
    const { transitions } = (await this.request('GET', path)) as { transitions?: { id: string; name: string; to?: { name?: string } }[] };
    const t = (transitions ?? []).find((x) => x.name.toLowerCase() === wanted || x.to?.name?.toLowerCase() === wanted);
    if (!t) throw new IssueTrackerError(`No Jira transition "${this.transitions[status]}" available for ${key}`, this.name);
    await this.request('POST', path, { transition: { id: t.id } }, tracker);
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
      url: `${this.siteBase}/browse/${d.key}`,
      assignees: f.assignee?.accountId ? [f.assignee.accountId] : [],
      labels: f.labels ?? []
    };
    if (f.updated) issue.updatedAt = f.updated;
    return issue;
  }

  private async authHeader(): Promise<string> {
    const c = await this.options.credentials.resolve(this.options.organizationId, this.options.integrationId);
    if (c.kind === 'jira' && c.email && c.apiToken) return 'Basic ' + Buffer.from(`${c.email}:${c.apiToken}`).toString('base64');
    if (c.kind === 'jira-oauth' && c.accessToken) return `Bearer ${c.accessToken}`;
    throw new IssueTrackerError('Jira credentials unavailable', this.name);
  }

  /** safeFetch: timeout via AbortController, no redirects, response size cap, sanitized errors. */
  private async raw(method: string, path: string, body?: unknown, tracker?: WriteAttemptTracker): Promise<JiraResponse> {
    return withRetry(
      async () => {
        tracker?.attempt(); // per underlying attempt (incl. retries) for audit attemptCount
        const res = await this.rawOnce(method, path, body);
        if (!res.ok && classifyHttpError({ status: res.status, header: res.header }, Date.now()).retry) throw new RetryableJiraResponse(res);
        return res;
      },
      (err, now) => {
        if (err instanceof RetryableJiraResponse) return classifyHttpError({ status: err.res.status, header: err.res.header }, now);
        // Network errors / timeouts: retried only for idempotent methods (withRetry enforces via `idempotent`).
        return err instanceof IssueTrackerError && err.status === undefined ? { retry: true } : { retry: false };
      },
      // POST (create issue, transition) is not idempotent: only retried when the server clearly did not process it.
      { ...this.options.retry, idempotent: isIdempotentMethod(method) && (this.options.retry?.idempotent ?? true) }
    ).catch((err: unknown) => {
      if (err instanceof RetryableJiraResponse) return err.res;
      throw err;
    });
  }

  private async rawOnce(method: string, path: string, body?: unknown): Promise<JiraResponse> {
    const headers: Record<string, string> = { Authorization: await this.authHeader(), Accept: 'application/json' };
    const init: SafeFetchInit = { method, headers, redirect: 'error' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    const max = this.options.maxResponseBytes ?? 1024 * 1024;
    try {
      const res = await this.fetchFn(`${this.base}${path}`, init);
      if (res.status >= 300 && res.status < 400) throw new IssueTrackerError(`Jira request failed (${res.status})`, this.name, res.status);
      const declared = Number(res.headers?.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > max) throw new IssueTrackerError('Jira response too large', this.name, res.status);
      const text = await res.text();
      if (Buffer.byteLength(text) > max) throw new IssueTrackerError('Jira response too large', this.name, res.status);
      return { ok: res.ok, status: res.status, body: text, header: (n: string) => res.headers?.get(n) ?? undefined };
    } catch (err) {
      if (err instanceof IssueTrackerError) throw err;
      const aborted = (err as { name?: string }).name === 'AbortError';
      throw new IssueTrackerError(aborted ? 'Jira request timed out' : 'Jira request failed', this.name);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(method: string, path: string, body?: unknown, tracker?: WriteAttemptTracker): Promise<unknown> {
    const res = await this.raw(method, path, body, tracker);
    if (!res.ok) throw this.httpError(res.status);
    if (res.status === 204 || !res.body) return {};
    try {
      return JSON.parse(res.body);
    } catch {
      throw new IssueTrackerError('Jira returned invalid JSON', this.name, res.status);
    }
  }

  /** Sanitized: status only, never upstream bodies/headers. */
  private httpError(status: number) {
    return new IssueTrackerError(`Jira request failed (${status})`, this.name, status);
  }
}
