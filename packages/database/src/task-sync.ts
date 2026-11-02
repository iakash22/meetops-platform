import { Prisma } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * Async task -> GitHub/Jira sync (TASK_SYNC_ENABLED). Every call runs inside the organization's forced-RLS context.
 *
 * State machine (one row per task + integration):
 *   queued --begin--> creating --succeed--> succeeded (link written to integration_issues in the same tx)
 *                              --finish(failed)--> failed           (definitely not created; a new request re-queues)
 *                              --finish(queued)--> queued           (not sent, transient; the job retries)
 *                              --finish(needs_reconcile)--> needs_reconcile (may exist upstream; never re-sent)
 * Transitions are conditional UPDATEs, so two workers can never both start the same create.
 */
export const TASK_SYNC_STATUSES = [
  'queued',
  'creating',
  'succeeded',
  'failed',
  'needs_reconcile',
] as const;
export type TaskSyncStatus = (typeof TASK_SYNC_STATUSES)[number];
export type TaskSyncProvider = 'github' | 'jira';

export interface TaskSyncJobRecord {
  id: string;
  organizationId: string;
  taskId: string;
  integrationId: string;
  approvalId: string;
  provider: TaskSyncProvider;
  target: string;
  status: TaskSyncStatus;
  attempts: number;
  externalId: string | null;
  externalUrl: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskSyncRequestInput {
  taskId: string;
  integrationId: string;
  approvalId: string;
  provider: TaskSyncProvider;
  target: string;
  requestedById?: string | null;
}

const SELECT = {
  id: true,
  organizationId: true,
  taskId: true,
  integrationId: true,
  approvalId: true,
  provider: true,
  target: true,
  status: true,
  attempts: true,
  externalId: true,
  externalUrl: true,
  errorCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

type Row = Prisma.TaskSyncJobGetPayload<{ select: typeof SELECT }>;
const toRecord = (r: Row): TaskSyncJobRecord => ({
  ...r,
  provider: r.provider as TaskSyncProvider,
  status: r.status as TaskSyncStatus,
});

const isUnique = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export function createTaskSyncRepository(options: RepositoryOptions = {}) {
  const run = <T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  const byTask = (tx: Prisma.TransactionClient, organizationId: string, i: TaskSyncRequestInput) =>
    tx.taskSyncJob.findFirst({
      where: { organizationId, taskId: i.taskId, integrationId: i.integrationId },
      select: SELECT,
    });

  return {
    /**
     * Idempotent request. An existing row is returned as is (`created: false`), except a `failed` one, which is
     * re-queued with the new approval/target (`created: true`). A concurrent insert race resolves to the winner's row.
     */
    async request(
      organizationId: string,
      input: TaskSyncRequestInput,
    ): Promise<{ job: TaskSyncJobRecord; created: boolean }> {
      try {
        return await run(organizationId, async (tx) => {
          const existing = await byTask(tx, organizationId, input);
          if (existing && existing.status !== 'failed')
            return { job: toRecord(existing), created: false };
          if (existing) {
            const n = await tx.taskSyncJob.updateMany({
              where: { id: existing.id, organizationId, status: 'failed' },
              data: {
                status: 'queued',
                approvalId: input.approvalId,
                target: input.target,
                errorCode: null,
                requestedById: input.requestedById ?? null,
              },
            });
            const row = await tx.taskSyncJob.findFirstOrThrow({
              where: { id: existing.id, organizationId },
              select: SELECT,
            });
            return { job: toRecord(row), created: n.count === 1 };
          }
          const row = await tx.taskSyncJob.create({
            data: {
              organizationId,
              taskId: input.taskId,
              integrationId: input.integrationId,
              approvalId: input.approvalId,
              provider: input.provider,
              target: input.target,
              requestedById: input.requestedById ?? null,
            },
            select: SELECT,
          });
          return { job: toRecord(row), created: true };
        });
      } catch (e) {
        if (!isUnique(e)) throw e;
        const row = await run(organizationId, (tx) => byTask(tx, organizationId, input));
        if (!row) throw e;
        return { job: toRecord(row), created: false };
      }
    },

    async findByTask(
      organizationId: string,
      taskId: string,
      integrationId: string,
    ): Promise<TaskSyncJobRecord | null> {
      const row = await run(organizationId, (tx) =>
        tx.taskSyncJob.findFirst({
          where: { organizationId, taskId, integrationId },
          select: SELECT,
        }),
      );
      return row ? toRecord(row) : null;
    },

    async get(organizationId: string, id: string): Promise<TaskSyncJobRecord | null> {
      const row = await run(organizationId, (tx) =>
        tx.taskSyncJob.findFirst({ where: { id, organizationId }, select: SELECT }),
      );
      return row ? toRecord(row) : null;
    },

    /** queued -> creating (attempts + 1). False when the row is not queued (another worker, or already done). */
    async begin(organizationId: string, id: string): Promise<boolean> {
      const n = await run(organizationId, (tx) =>
        tx.taskSyncJob.updateMany({
          where: { id, organizationId, status: 'queued' },
          data: { status: 'creating', attempts: { increment: 1 }, errorCode: null },
        }),
      );
      return n.count === 1;
    },

    /** creating -> succeeded, and the task's integration_issues link, in one transaction. */
    async succeed(
      organizationId: string,
      id: string,
      issue: { externalId: string; externalUrl?: string | null },
    ): Promise<boolean> {
      const url = issue.externalUrl?.startsWith('https://') ? issue.externalUrl : null;
      return run(organizationId, async (tx) => {
        const row = await tx.taskSyncJob.findFirst({
          where: { id, organizationId, status: 'creating' },
          select: SELECT,
        });
        if (!row) return false;
        await tx.taskSyncJob.update({
          where: { id: row.id },
          data: { status: 'succeeded', externalId: issue.externalId, externalUrl: url },
        });
        const linked = await tx.integrationIssue.findFirst({
          where: { organizationId, provider: row.provider, externalId: issue.externalId },
          select: { id: true },
        });
        if (!linked)
          await tx.integrationIssue.create({
            data: {
              organizationId,
              taskId: row.taskId,
              integrationId: row.integrationId,
              integration: row.provider,
              provider: row.provider,
              externalId: issue.externalId,
              externalUrl: url,
              syncedAt: new Date(),
            },
          });
        return true;
      });
    },

    /** creating -> queued | failed | needs_reconcile. False when the row was not `creating`. */
    async finish(
      organizationId: string,
      id: string,
      status: 'queued' | 'failed' | 'needs_reconcile',
      errorCode: string,
    ): Promise<boolean> {
      const n = await run(organizationId, (tx) =>
        tx.taskSyncJob.updateMany({
          where: { id, organizationId, status: 'creating' },
          data: { status, errorCode: errorCode.slice(0, 64) },
        }),
      );
      return n.count === 1;
    },

    /** Terminal failure before any attempt started (e.g. approval revoked while queued): queued -> failed. */
    async reject(organizationId: string, id: string, errorCode: string): Promise<boolean> {
      const n = await run(organizationId, (tx) =>
        tx.taskSyncJob.updateMany({
          where: { id, organizationId, status: 'queued' },
          data: { status: 'failed', errorCode: errorCode.slice(0, 64) },
        }),
      );
      return n.count === 1;
    },
  };
}

export type TaskSyncRepository = ReturnType<typeof createTaskSyncRepository>;
