import {
  ApprovalRequiredError,
  AuditRecordError,
  GitHubIssuesProvider,
  JiraIssueTrackerProvider,
  computeWritePayloadHash,
  type AuditEvent,
  type CreateIssueInput,
  type FetchLike,
  type GitHubIssuesClient,
  type IntegrationCredentials,
  type Issue,
  type IssueTrackerProvider,
} from '@meetops/integrations';
import type { TaskSyncJobPayload } from '@meetops/contracts';
import type { TaskSyncRepository } from '@meetops/database';

/**
 * Worker side of the async task sync (TASK_SYNC_ENABLED). Creates the GitHub/Jira issue for one task_sync_jobs row
 * through the existing adapters (GitHubIssuesProvider / JiraIssueTrackerProvider, which enforce the write approval
 * and audit every attempt) and stores the external id + URL on the task (integration_issues) in the same transaction
 * that marks the row succeeded.
 *
 * Duplicate safety (ADR-007: a non-idempotent create is never re-sent after it may have reached the provider):
 * - The row moves queued -> creating with a conditional UPDATE, so only one worker can start a create.
 * - A failure with zero underlying HTTP attempts (credentials, approval re-check, audit store) was not sent: the
 *   row goes back to `queued` and the BullMQ job retries.
 * - A 4xx after sending was rejected by the provider: `failed` (a new request may re-queue it).
 * - Anything else after sending (5xx, timeout, network) or a row found already `creating` (crash mid-create) is
 *   ambiguous: `needs_reconcile`, never retried automatically.
 * No provider fallback: the job uses exactly the integration the request named.
 */

export type TaskSyncJobStore = Pick<
  TaskSyncRepository,
  'get' | 'begin' | 'succeed' | 'finish' | 'reject'
>;

export interface TaskSyncConnection {
  id: string;
  organizationId: string;
  provider: 'github' | 'jira';
  status: 'active' | 'error' | 'revoked';
  externalAccountId: string;
  displayName: string;
}

/** Org-scoped (RLS) reads the job needs; the worker's Prisma implementation runs each in withOrganizationContext. */
export interface TaskSyncLookups {
  connection(organizationId: string, integrationId: string): Promise<TaskSyncConnection | null>;
  task(
    organizationId: string,
    taskId: string,
  ): Promise<{
    id: string;
    title: string;
    description: string | null;
    extractedTaskId: string | null;
  } | null>;
  approval(
    organizationId: string,
    approvalId: string,
  ): Promise<{
    id: string;
    extractedTaskId: string;
    reviewerId: string | null;
    decision: string;
  } | null>;
  hasIssueLink(organizationId: string, taskId: string, integrationId: string): Promise<boolean>;
}

export interface TaskSyncLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TaskSyncDeps {
  jobs: TaskSyncJobStore;
  lookups: TaskSyncLookups;
  /** Decrypted credentials for the connection, resolved right before use (never logged). */
  credentials(conn: TaskSyncConnection): Promise<IntegrationCredentials>;
  /** Audit sink for the adapters' attempt/success/failure events (ids and codes only). */
  audit(event: AuditEvent): Promise<void>;
  log: TaskSyncLog;
  /** Tests inject a mocked GitHub client / fetch; production uses Octokit / global fetch. */
  githubClientFactory?: (token: string) => GitHubIssuesClient;
  fetch?: FetchLike;
}

export type TaskSyncResult = 'succeeded' | 'failed' | 'needs_reconcile' | 'skipped';

/** Thrown for a create that was not sent and may be retried (BullMQ backoff). The row is back to `queued`. */
export class TaskSyncRetryableError extends Error {
  constructor(readonly code: string) {
    super(`task sync not sent (${code}); will retry`);
    this.name = 'TaskSyncRetryableError';
  }
}

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

function buildProvider(
  deps: TaskSyncDeps,
  conn: TaskSyncConnection,
  verify: () => Promise<boolean>,
  onFailure: (attemptCount: number) => void,
): IssueTrackerProvider {
  const ctx = { organizationId: conn.organizationId, integrationId: conn.id };
  const audit = {
    record: async (e: AuditEvent) => {
      if (e.phase === 'failure') onFailure(e.attemptCount ?? 0);
      await deps.audit(e);
    },
  };
  const approvals = { verify };
  const credentials = { resolve: () => deps.credentials(conn) };
  if (conn.provider === 'github')
    return new GitHubIssuesProvider({
      ...ctx,
      approvals,
      audit,
      credentials,
      ...(deps.githubClientFactory ? { clientFactory: deps.githubClientFactory } : {}),
    });
  return new JiraIssueTrackerProvider({
    ...ctx,
    approvals,
    audit,
    credentials,
    baseUrl: `https://api.atlassian.com/ex/jira/${conn.externalAccountId}`,
    siteUrl: `https://${conn.displayName}`,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

export async function processTaskSyncJob(
  deps: TaskSyncDeps,
  payload: TaskSyncJobPayload,
): Promise<TaskSyncResult> {
  const { organizationId, syncId } = payload;
  const ids = { organizationId, syncId };
  const row = await deps.jobs.get(organizationId, syncId);
  if (!row) {
    deps.log.warn(ids, 'task sync row not found; dropping job');
    return 'skipped';
  }
  if (row.status === 'creating') {
    // A previous attempt stopped mid-create: the issue may exist upstream. Never re-send.
    await deps.jobs.finish(organizationId, syncId, 'needs_reconcile', 'INTERRUPTED');
    deps.log.warn(ids, 'task sync interrupted mid-create; needs reconcile');
    return 'needs_reconcile';
  }
  if (row.status !== 'queued') return 'skipped';

  const conn = await deps.lookups.connection(organizationId, row.integrationId);
  if (!conn || conn.status !== 'active' || conn.provider !== row.provider) {
    await deps.jobs.reject(organizationId, syncId, 'INTEGRATION_NOT_CONNECTED');
    return 'failed';
  }
  const task = await deps.lookups.task(organizationId, row.taskId);
  if (!task) {
    await deps.jobs.reject(organizationId, syncId, 'TASK_NOT_FOUND');
    return 'failed';
  }
  const isValidApproval = (a: Awaited<ReturnType<typeof deps.lookups.approval>>) =>
    Boolean(
      a &&
      a.decision === 'approved' &&
      a.reviewerId &&
      task.extractedTaskId &&
      a.extractedTaskId === task.extractedTaskId,
    );
  // Fresh read for the write-time verifier (the approval may be revoked while the job runs).
  const approvalOk = async () =>
    isValidApproval(await deps.lookups.approval(organizationId, row.approvalId));
  // Gate on a single read: the approval that is checked is the one whose id/reviewer goes into the write.
  const approval = await deps.lookups.approval(organizationId, row.approvalId);
  if (!approval?.reviewerId || !isValidApproval(approval)) {
    await deps.jobs.reject(organizationId, syncId, 'APPROVAL_REQUIRED');
    return 'failed';
  }
  if (await deps.lookups.hasIssueLink(organizationId, row.taskId, row.integrationId)) {
    await deps.jobs.reject(organizationId, syncId, 'ALREADY_LINKED');
    return 'failed';
  }
  if (!(await deps.jobs.begin(organizationId, syncId))) return 'skipped';

  const input: CreateIssueInput = {
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    project: row.target,
    externalRef: `meetops:task:${task.id}`,
  };
  // Same canonical hash as the API's synchronous push (TaskApproval has no stored hash yet).
  const payloadHash = computeWritePayloadHash(
    'createIssue',
    { provider: row.provider, organizationId, integrationId: row.integrationId },
    input,
  );
  const writeApproval = {
    approvalId: approval.id,
    organizationId,
    approverUserId: approval.reviewerId,
    payloadHash,
  };
  let sentAttempts = 0;
  const provider = buildProvider(
    deps,
    conn,
    async () =>
      (await approvalOk()) &&
      !(await deps.lookups.hasIssueLink(organizationId, row.taskId, row.integrationId)),
    (n) => (sentAttempts = n),
  );

  let issue: Issue;
  try {
    issue = await provider.createIssue(input, writeApproval);
  } catch (err) {
    if (err instanceof AuditRecordError) {
      issue = err.result as Issue; // created upstream; only the success audit failed
    } else if (err instanceof ApprovalRequiredError) {
      await deps.jobs.finish(organizationId, syncId, 'failed', 'APPROVAL_REQUIRED');
      return 'failed';
    } else {
      const status = statusOf(err);
      if (sentAttempts === 0) {
        await deps.jobs.finish(organizationId, syncId, 'queued', 'NOT_SENT');
        throw new TaskSyncRetryableError('NOT_SENT');
      }
      if (
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        await deps.jobs.finish(organizationId, syncId, 'failed', `PROVIDER_REJECTED_${status}`);
        deps.log.warn({ ...ids, status }, 'task sync rejected by provider');
        return 'failed';
      }
      await deps.jobs.finish(organizationId, syncId, 'needs_reconcile', 'AMBIGUOUS_PROVIDER_ERROR');
      deps.log.warn(
        { ...ids, status: status ?? null },
        'task sync outcome unknown; needs reconcile',
      );
      return 'needs_reconcile';
    }
  }
  await deps.jobs.succeed(organizationId, syncId, {
    externalId: issue.key,
    externalUrl: issue.url,
  });
  deps.log.info({ ...ids, externalId: issue.key }, 'task synced');
  return 'succeeded';
}
