import { randomUUID } from 'node:crypto';
import type { ExtractedTask, Task } from '@meetops/contracts';
import { keysetPage } from '../directory/cursor.js';
import {
  ExtractedTaskAlreadyReviewed,
  ExtractedTaskMissing,
  TaskMissing,
  TaskAssigneeInvalid,
  TaskReferenceInvalid,
  type AcceptInput,
  type CreateTaskInput,
  type TaskPatch,
  type TaskFilter,
  type TaskRepositories,
} from './ports.js';

type Stored<T> = T & { organizationId: string };
type ExtractedRow = Stored<ExtractedTask> & { status: 'pending_review' | 'converted' | 'rejected' };
export type ApprovalRow = {
  organizationId: string;
  extractedTaskId: string;
  reviewerId: string;
  decision: 'approved' | 'rejected';
};

const key = (r: { createdAt: string; id: string }) => ({
  createdAt: new Date(r.createdAt),
  id: r.id,
});

function publicExtracted(row: ExtractedRow): ExtractedTask {
  const e: Partial<ExtractedRow> = { ...row };
  delete e.organizationId;
  delete e.status;
  return e as ExtractedTask;
}

/** Development/test only. */
export class InMemoryTasks implements TaskRepositories {
  readonly tasks: Task[] = [];
  readonly extracted: ExtractedRow[] = [];
  readonly approvals: ApprovalRow[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  addExtracted(organizationId: string, t: ExtractedTask) {
    this.extracted.push({ ...t, organizationId, status: 'pending_review' });
  }

  listTasks(organizationId: string, f: TaskFilter) {
    const q = f.q?.toLowerCase();
    const rows = this.tasks.filter(
      (t) =>
        t.organizationId === organizationId &&
        (!f.status || f.status.includes(t.status)) &&
        (!f.priority || t.priority === f.priority) &&
        (!f.projectId || t.projectId === f.projectId) &&
        (!f.meetingId || t.meetingId === f.meetingId) &&
        (!f.assigneeId || t.assigneeId === f.assigneeId) &&
        (!f.unassigned || !t.assigneeId) &&
        (!f.dueBefore || (!!t.dueAt && new Date(t.dueAt) < f.dueBefore)) &&
        (!f.dueAfter || (!!t.dueAt && new Date(t.dueAt) > f.dueAfter)) &&
        (!q || t.title.toLowerCase().includes(q)),
    );
    return Promise.resolve(keysetPage(rows, key, f));
  }

  listPendingExtracted(
    organizationId: string,
    q: { meetingId?: string | undefined; cursor?: string | undefined; limit: number },
  ) {
    const rows = this.extracted.filter(
      (e) =>
        e.organizationId === organizationId &&
        e.status === 'pending_review' &&
        (!q.meetingId || e.meetingId === q.meetingId),
    );
    const page = keysetPage(rows, key, q);
    return Promise.resolve({ items: page.items.map(publicExtracted), nextCursor: page.nextCursor });
  }

  /** Test hook: when set, assigneeIds outside this set are rejected like the Prisma FK check. */
  employees: Set<string> | undefined;

  /** Test hooks: when set, ids outside these sets are rejected like the Prisma existence checks. */
  projects: Set<string> | undefined;
  meetings: Set<string> | undefined;

  createTask(organizationId: string, input: CreateTaskInput) {
    if (input.assigneeId && this.employees && !this.employees.has(input.assigneeId))
      return Promise.reject(new TaskAssigneeInvalid());
    if (input.projectId && this.projects && !this.projects.has(input.projectId))
      return Promise.reject(new TaskReferenceInvalid('projectId'));
    if (input.meetingId && this.meetings && !this.meetings.has(input.meetingId))
      return Promise.reject(new TaskReferenceInvalid('meetingId'));
    const at = this.now().toISOString();
    const task: Task = {
      id: randomUUID(),
      organizationId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.meetingId ? { meetingId: input.meetingId } : {}),
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: input.status,
      priority: input.priority,
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      ...(input.dueAt ? { dueAt: input.dueAt.toISOString() } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.push(task);
    return Promise.resolve(task);
  }

  getTask(organizationId: string, taskId: string) {
    const t = this.tasks.find((x) => x.organizationId === organizationId && x.id === taskId);
    return t ? Promise.resolve(t) : Promise.reject(new TaskMissing());
  }

  updateTask(organizationId: string, taskId: string, p: TaskPatch) {
    const i = this.tasks.findIndex((x) => x.organizationId === organizationId && x.id === taskId);
    if (i < 0) return Promise.reject(new TaskMissing());
    if (p.assigneeId && this.employees && !this.employees.has(p.assigneeId))
      return Promise.reject(new TaskAssigneeInvalid());
    const next: Task = { ...this.tasks[i]!, updatedAt: this.now().toISOString() };
    if (p.title !== undefined) next.title = p.title;
    if (p.status !== undefined) next.status = p.status;
    if (p.priority !== undefined) next.priority = p.priority;
    if (p.description === null) delete next.description;
    else if (p.description !== undefined) next.description = p.description;
    if (p.assigneeId === null) delete next.assigneeId;
    else if (p.assigneeId !== undefined) next.assigneeId = p.assigneeId;
    if (p.dueAt === null) delete next.dueAt;
    else if (p.dueAt !== undefined) next.dueAt = p.dueAt.toISOString();
    this.tasks[i] = next;
    return Promise.resolve(next);
  }

  private pending(organizationId: string, id: string) {
    const e = this.extracted.find((x) => x.organizationId === organizationId && x.id === id);
    if (!e) throw new ExtractedTaskMissing();
    if (e.status !== 'pending_review') throw new ExtractedTaskAlreadyReviewed();
    return e;
  }

  accept(organizationId: string, input: AcceptInput) {
    const e = this.pending(organizationId, input.extractedTaskId);
    const at = this.now().toISOString();
    const task: Task = {
      id: randomUUID(),
      organizationId,
      meetingId: e.meetingId,
      extractedTaskId: e.id,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      status: 'todo',
      priority: input.priority,
      ...(input.dueAt ? { dueAt: input.dueAt.toISOString() } : {}),
      createdAt: at,
      updatedAt: at,
    };
    e.status = 'converted';
    this.tasks.push(task);
    this.approvals.push({
      organizationId,
      extractedTaskId: e.id,
      reviewerId: input.reviewerId,
      decision: 'approved',
    });
    return Promise.resolve(task);
  }

  dismiss(organizationId: string, input: { extractedTaskId: string; reviewerId: string }) {
    const e = this.pending(organizationId, input.extractedTaskId);
    e.status = 'rejected';
    this.approvals.push({
      organizationId,
      extractedTaskId: e.id,
      reviewerId: input.reviewerId,
      decision: 'rejected',
    });
    return Promise.resolve();
  }
}
