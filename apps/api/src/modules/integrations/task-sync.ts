import { randomUUID } from 'node:crypto';
import { Queue, type JobsOptions } from 'bullmq';
import {
  TASK_SYNC_JOB_NAME,
  TASK_SYNC_QUEUE,
  type TaskSyncJob,
  type TaskSyncJobPayload,
} from '@meetops/contracts';
import {
  createTaskSyncRepository,
  type TaskSyncJobRecord,
  type TaskSyncRequestInput,
} from '@meetops/database';
import { DomainError } from '../../shared/domain-error.js';
import type { DatabaseClient } from '../../shared/prisma/context.js';
import {
  ApprovalRequiredHttpError,
  IntegrationNotConnectedError,
  IntegrationNotFoundError,
  InvalidTargetError,
  IssueAlreadyLinkedError,
  TaskNotFoundError,
} from './errors.js';
import type { IntegrationsRepository } from './ports.js';

/**
 * Async task -> GitHub/Jira sync (TASK_SYNC_ENABLED, off by default). The API validates and records the request
 * (task_sync_jobs, forced RLS) and enqueues a BullMQ job; the worker creates the issue. No provider is called here
 * and there is no fallback between providers: the job uses exactly the requested integration.
 */
export function taskSyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.TASK_SYNC_ENABLED ?? '').trim().toLowerCase();
  if (v === '' || ['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  throw new Error('TASK_SYNC_ENABLED must be a boolean');
}

export interface TaskSyncStore {
  findByTask(
    organizationId: string,
    taskId: string,
    integrationId: string,
  ): Promise<TaskSyncJobRecord | null>;
  request(
    organizationId: string,
    input: TaskSyncRequestInput,
  ): Promise<{ job: TaskSyncJobRecord; created: boolean }>;
}

export interface TaskSyncQueue {
  enqueue(payload: TaskSyncJobPayload): Promise<void>;
  close?(): Promise<void>;
}

export class TaskSyncQueueUnavailableError extends DomainError {
  constructor() {
    super('PROVIDER_UNAVAILABLE', 'Task sync queue is unavailable; retry the request', 503);
  }
}

export class PrismaTaskSyncStore implements TaskSyncStore {
  private readonly repo;
  constructor(db: DatabaseClient) {
    this.repo = createTaskSyncRepository({ client: db });
  }
  request(organizationId: string, input: TaskSyncRequestInput) {
    return this.repo.request(organizationId, input);
  }
  findByTask(organizationId: string, taskId: string, integrationId: string) {
    return this.repo.findByTask(organizationId, taskId, integrationId);
  }
}

/** Tests / development only (selected explicitly when there is no database). */
export class InMemoryTaskSyncStore implements TaskSyncStore {
  readonly rows: TaskSyncJobRecord[] = [];
  async findByTask(organizationId: string, taskId: string, integrationId: string) {
    const r = this.rows.find(
      (x) =>
        x.organizationId === organizationId &&
        x.taskId === taskId &&
        x.integrationId === integrationId,
    );
    return r ? { ...r } : null;
  }
  async request(organizationId: string, input: TaskSyncRequestInput) {
    const existing = this.rows.find(
      (r) =>
        r.organizationId === organizationId &&
        r.taskId === input.taskId &&
        r.integrationId === input.integrationId,
    );
    if (existing && existing.status !== 'failed') return { job: { ...existing }, created: false };
    const now = new Date();
    if (existing) {
      Object.assign(existing, {
        status: 'queued',
        approvalId: input.approvalId,
        target: input.target,
        errorCode: null,
        updatedAt: now,
      });
      return { job: { ...existing }, created: true };
    }
    const job: TaskSyncJobRecord = {
      id: randomUUID(),
      organizationId,
      taskId: input.taskId,
      integrationId: input.integrationId,
      approvalId: input.approvalId,
      provider: input.provider,
      target: input.target,
      status: 'queued',
      attempts: 0,
      externalId: null,
      externalUrl: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(job);
    return { job: { ...job }, created: true };
  }
}

/**
 * BullMQ job id per sync row (no ':'). Completed/failed jobs are removed so a re-queued row (after `failed`) can be
 * enqueued again; while a job is live a duplicate add is a no-op. The worker's row state machine is the real guard.
 */
export const taskSyncJobId = (p: TaskSyncJobPayload) => `tasksync_${p.organizationId}_${p.syncId}`;
export const TASK_SYNC_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const satisfies JobsOptions;

export function createBullMqTaskSyncQueue(
  redisUrl: string,
  onError: (err: Error) => void = (err) => process.emitWarning(`task sync queue: ${err.message}`),
): TaskSyncQueue {
  let queue: Queue<TaskSyncJobPayload> | undefined;
  const get = () => {
    if (!queue) {
      queue = new Queue<TaskSyncJobPayload>(TASK_SYNC_QUEUE, {
        connection: { url: redisUrl, maxRetriesPerRequest: null },
      });
      queue.on('error', onError);
    }
    return queue;
  };
  return {
    enqueue: async (payload) => {
      await get().add(TASK_SYNC_JOB_NAME, payload, {
        ...TASK_SYNC_JOB_OPTIONS,
        jobId: taskSyncJobId(payload),
      });
    },
    close: async () => {
      await queue?.close();
    },
  };
}

export function toTaskSyncJob(r: TaskSyncJobRecord): TaskSyncJob {
  return {
    id: r.id,
    taskId: r.taskId,
    integrationId: r.integrationId,
    provider: r.provider,
    target: r.target,
    status: r.status,
    attempts: r.attempts,
    ...(r.externalId ? { externalId: r.externalId } : {}),
    ...(r.externalUrl ? { externalUrl: r.externalUrl } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class TaskSyncService {
  constructor(
    private readonly repo: IntegrationsRepository,
    private readonly store: TaskSyncStore,
    private readonly queue: TaskSyncQueue,
  ) {}

  /** Validates (same rules as the synchronous push), records the request idempotently and enqueues it. */
  async request(input: {
    organizationId: string;
    userId: string;
    taskId: string;
    integrationId: string;
    approvalId: string;
    target: string;
  }): Promise<TaskSyncJobRecord> {
    const { organizationId, taskId, integrationId } = input;
    const conn = await this.repo.get(organizationId, integrationId);
    if (!conn) throw new IntegrationNotFoundError();
    if (conn.status !== 'active') throw new IntegrationNotConnectedError();
    if ((conn.provider === 'github') !== input.target.includes('/')) throw new InvalidTargetError();
    const task = await this.repo.getTask(organizationId, taskId);
    if (!task) throw new TaskNotFoundError();
    const approval = await this.repo.getApproval(organizationId, input.approvalId);
    if (
      !approval ||
      approval.decision !== 'approved' ||
      !approval.reviewerId ||
      !task.extractedTaskId ||
      approval.extractedTaskId !== task.extractedTaskId
    )
      throw new ApprovalRequiredHttpError();

    const existing = await this.store.findByTask(organizationId, taskId, integrationId);
    // A link made by the synchronous push (no live sync row of ours) must not be duplicated.
    if (
      (!existing || existing.status === 'failed') &&
      (await this.repo.hasIssueLink(organizationId, taskId, integrationId))
    )
      throw new IssueAlreadyLinkedError();
    const { job } = await this.store.request(organizationId, {
      taskId,
      integrationId,
      approvalId: approval.id,
      provider: conn.provider,
      target: input.target,
      requestedById: input.userId,
    });
    // Queued rows are (re-)enqueued on every request: a lost enqueue heals on retry; a live job id is a no-op.
    if (job.status === 'queued') {
      try {
        await this.queue.enqueue({ jobVersion: 1, organizationId, syncId: job.id });
      } catch {
        throw new TaskSyncQueueUnavailableError();
      }
    }
    return job;
  }
}
