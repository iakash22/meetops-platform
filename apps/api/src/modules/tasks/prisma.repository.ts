import type { ExtractedTask, Task } from '@meetops/contracts';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import { decodeCursor, encodeCursor, type CursorKey } from '../directory/cursor.js';
import type { Page } from '../directory/ports.js';
import {
  ExtractedTaskAlreadyReviewed,
  ExtractedTaskMissing,
  TaskAssigneeInvalid,
  TaskMissing,
  TaskReferenceInvalid,
  type AcceptInput,
  type CreateTaskInput,
  type TaskFilter,
  type TaskPatch,
  type TaskAnalyticsResult,
  type TaskRepositories,
} from './ports.js';

type TaskRow = {
  id: string;
  organizationId: string;
  projectId: string | null;
  meetingId: string | null;
  extractedTaskId: string | null;
  title: string;
  description: string | null;
  status: Task['status'];
  priority: Task['priority'];
  assigneeId: string | null;
  dueAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type ExtractedRow = {
  id: string;
  meetingId: string;
  reportId: string;
  title: string;
  description: string | null;
  assigneeHint: string | null;
  dueHint: string | null;
  confidence: number | null;
  sourceSegmentIds: string[];
  createdAt: Date;
};

const opt = <K extends string, V>(k: K, v: V | null | undefined) =>
  v === null || v === undefined ? {} : ({ [k]: v } as { [P in K]: V });

export const toTask = (r: TaskRow): Task => ({
  id: r.id,
  organizationId: r.organizationId,
  ...opt('projectId', r.projectId),
  ...opt('meetingId', r.meetingId),
  ...opt('extractedTaskId', r.extractedTaskId),
  title: r.title,
  ...opt('description', r.description),
  status: r.status,
  priority: r.priority,
  ...opt('assigneeId', r.assigneeId),
  ...opt('dueAt', r.dueAt?.toISOString()),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const toExtracted = (r: ExtractedRow): ExtractedTask => ({
  id: r.id,
  meetingId: r.meetingId,
  reportId: r.reportId,
  title: r.title,
  ...opt('description', r.description),
  ...opt('assigneeHint', r.assigneeHint),
  ...opt('dueHint', r.dueHint),
  confidence: r.confidence ?? 0,
  sourceSegmentIds: r.sourceSegmentIds,
  createdAt: r.createdAt.toISOString(),
});

/** (createdAt, id) > cursor, matching the directory keyset order. */
const after = (k: CursorKey | null) =>
  k
    ? { OR: [{ createdAt: { gt: k.createdAt } }, { createdAt: k.createdAt, id: { gt: k.id } }] }
    : {};

function page<R extends { id: string; createdAt: Date }, T>(
  rows: R[],
  limit: number,
  map: (r: R) => T,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/**
 * Prisma-backed tasks + review. Every call runs in withOrganizationContext (forced RLS) and also filters by
 * organizationId. Accept/dismiss flip the extracted task with a conditional updateMany on status = pending_review,
 * so exactly one concurrent reviewer wins; the loser gets ExtractedTaskAlreadyReviewed and its transaction rolls back.
 */
export class PrismaTasks implements TaskRepositories {
  constructor(
    private readonly client: DatabaseClient,
    private readonly timeoutMs?: number,
  ) {}

  private run<T>(orgId: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) {
    return withOrganizationContext(orgId, fn, {
      client: this.client,
      ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
    });
  }

  listTasks(organizationId: string, f: TaskFilter) {
    const cursor = f.cursor === undefined ? null : decodeCursor(f.cursor);
    return this.run(organizationId, async (tx) => {
      const rows = await tx.task.findMany({
        where: {
          organizationId,
          deletedAt: null,
          ...after(cursor),
          ...(f.status ? { status: { in: f.status } } : {}),
          ...(f.priority ? { priority: f.priority } : {}),
          ...(f.projectId ? { projectId: f.projectId } : {}),
          ...(f.meetingId ? { meetingId: f.meetingId } : {}),
          ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}),
          ...(f.unassigned ? { assigneeId: null } : {}),
          ...(f.dueBefore || f.dueAfter
            ? {
                dueAt: {
                  ...(f.dueBefore ? { lt: f.dueBefore } : {}),
                  ...(f.dueAfter ? { gt: f.dueAfter } : {}),
                },
              }
            : {}),
          ...(f.q ? { title: { contains: f.q, mode: 'insensitive' as const } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: f.limit + 1,
      });
      return page(rows as TaskRow[], f.limit, toTask);
    });
  }

  listPendingExtracted(
    organizationId: string,
    q: { meetingId?: string | undefined; cursor?: string | undefined; limit: number },
  ) {
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    return this.run(organizationId, async (tx) => {
      const rows = await tx.extractedTask.findMany({
        where: {
          organizationId,
          deletedAt: null,
          status: 'pending_review',
          ...(q.meetingId ? { meetingId: q.meetingId } : {}),
          ...after(cursor),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: q.limit + 1,
      });
      return page(rows as ExtractedRow[], q.limit, toExtracted);
    });
  }

  private async claim(
    tx: Parameters<Parameters<typeof withOrganizationContext>[1]>[0],
    organizationId: string,
    id: string,
    to: 'converted' | 'rejected',
  ) {
    const { count } = await tx.extractedTask.updateMany({
      where: { organizationId, id, deletedAt: null, status: 'pending_review' },
      data: { status: to },
    });
    if (count === 1) return;
    const exists = await tx.extractedTask.findFirst({
      where: { organizationId, id, deletedAt: null },
      select: { id: true },
    });
    throw exists ? new ExtractedTaskAlreadyReviewed() : new ExtractedTaskMissing();
  }

  getTask(organizationId: string, taskId: string) {
    return this.run(organizationId, async (tx) => {
      const t = await tx.task.findFirst({ where: { organizationId, id: taskId, deletedAt: null } });
      if (!t) throw new TaskMissing();
      return toTask(t);
    });
  }

  createTask(organizationId: string, input: CreateTaskInput) {
    return this.run(organizationId, async (tx) => {
      if (
        input.assigneeId &&
        !(await tx.employee.findFirst({
          where: { organizationId, id: input.assigneeId, deletedAt: null },
          select: { id: true },
        }))
      )
        throw new TaskAssigneeInvalid();
      if (
        input.projectId &&
        !(await tx.project.findFirst({
          where: { organizationId, id: input.projectId, deletedAt: null },
          select: { id: true },
        }))
      )
        throw new TaskReferenceInvalid('projectId');
      if (
        input.meetingId &&
        !(await tx.meeting.findFirst({
          where: { organizationId, id: input.meetingId, deletedAt: null },
          select: { id: true },
        }))
      )
        throw new TaskReferenceInvalid('meetingId');
      const t = await tx.task.create({
        data: {
          organizationId,
          createdById: input.createdById,
          title: input.title,
          description: input.description ?? null,
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId ?? null,
          projectId: input.projectId ?? null,
          meetingId: input.meetingId ?? null,
          dueAt: input.dueAt ?? null,
        },
      });
      return toTask(t);
    });
  }

  updateTask(organizationId: string, taskId: string, p: TaskPatch) {
    return this.run(organizationId, async (tx) => {
      if (p.assigneeId) {
        const e = await tx.employee.findFirst({
          where: { organizationId, id: p.assigneeId, deletedAt: null },
          select: { id: true },
        });
        if (!e) throw new TaskAssigneeInvalid();
      }
      const n = await tx.task.updateMany({
        where: { organizationId, id: taskId, deletedAt: null },
        data: {
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.status !== undefined ? { status: p.status } : {}),
          ...(p.priority !== undefined ? { priority: p.priority } : {}),
          ...(p.assigneeId !== undefined ? { assigneeId: p.assigneeId } : {}),
          ...(p.dueAt !== undefined ? { dueAt: p.dueAt } : {}),
        },
      });
      if (n.count === 0) throw new TaskMissing();
      const t = await tx.task.findFirstOrThrow({ where: { organizationId, id: taskId } });
      return toTask(t);
    });
  }

  accept(organizationId: string, input: AcceptInput) {
    return this.run(organizationId, async (tx) => {
      await this.claim(tx, organizationId, input.extractedTaskId, 'converted');
      const e = await tx.extractedTask.findFirstOrThrow({
        where: { organizationId, id: input.extractedTaskId },
        select: { meetingId: true },
      });
      await tx.taskApproval.create({
        data: {
          organizationId,
          extractedTaskId: input.extractedTaskId,
          reviewerId: input.reviewerId,
          decision: 'approved',
        },
      });
      const t = await tx.task.create({
        data: {
          organizationId,
          extractedTaskId: input.extractedTaskId,
          meetingId: e.meetingId,
          createdById: input.reviewerId,
          title: input.title,
          priority: input.priority,
          description: input.description ?? null,
          dueAt: input.dueAt ?? null,
        },
      });
      return toTask(t);
    });
  }

  dismiss(organizationId: string, input: { extractedTaskId: string; reviewerId: string }) {
    return this.run(organizationId, async (tx) => {
      await this.claim(tx, organizationId, input.extractedTaskId, 'rejected');
      await tx.taskApproval.create({
        data: {
          organizationId,
          extractedTaskId: input.extractedTaskId,
          reviewerId: input.reviewerId,
          decision: 'rejected',
        },
      });
    });
  }

  /**
   * Aggregate-only reads in ONE org-context transaction (forced RLS) plus an explicit org_id filter, like
   * PrismaMeetingRepository.analytics. No writes.
   */
  async analytics(
    organizationId: string,
    q: { from: Date; to: Date },
  ): Promise<TaskAnalyticsResult> {
    const createdAt = { gte: q.from, lt: q.to };
    return this.run(organizationId, async (tx) => {
      const tasks = await tx.task.groupBy({
        by: ['status'],
        where: { organizationId, deletedAt: null, createdAt },
        _count: { _all: true },
      });
      const extracted = await tx.extractedTask.groupBy({
        by: ['status'],
        where: { organizationId, deletedAt: null, createdAt },
        _count: { _all: true },
      });
      const approvals = await tx.taskApproval.groupBy({
        by: ['decision'],
        where: { organizationId, createdAt },
        _count: { _all: true },
      });
      const sum = (rows: { _count: { _all: number } }[]) =>
        rows.reduce((n, r) => n + r._count._all, 0);
      // Alphabetical (Postgres would order enums by declaration), like the in-memory adapter.
      return {
        tasks: {
          total: sum(tasks),
          byStatus: tasks
            .map((r) => ({ status: r.status, count: r._count._all }))
            .sort((a, b) => a.status.localeCompare(b.status)),
        },
        extractedTasks: {
          total: sum(extracted),
          byStatus: extracted
            .map((r) => ({ status: r.status, count: r._count._all }))
            .sort((a, b) => a.status.localeCompare(b.status)),
        },
        approvals: {
          total: sum(approvals),
          byDecision: approvals
            .map((r) => ({ decision: r.decision, count: r._count._all }))
            .sort((a, b) => a.decision.localeCompare(b.decision)),
        },
      };
    });
  }
}
