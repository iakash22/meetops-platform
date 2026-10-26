import { randomUUID } from 'node:crypto';
import type { ExtractedTask, Task } from '@meetops/contracts';
import { keysetPage } from '../directory/cursor.js';
import {
  ExtractedTaskAlreadyReviewed,
  ExtractedTaskMissing,
  type AcceptInput,
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
