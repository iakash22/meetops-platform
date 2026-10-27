import type { ExtractedTask, Id, Paginated, Task, TaskPriority } from '@meetops/contracts';
import type { UpdateTaskRequest } from '@meetops/contracts';
import { TASK_PATHS } from '@meetops/contracts/types';
import type { HttpMethod } from '@/lib/api/client';
import { fillPath } from '@/features/uploads/types';

/**
 * Phase 4 task review on the task API (#222), contracts 0.8.0 `TASK_PATHS`.
 * - pending: GET extracted tasks awaiting review (200 with an empty page when none; an old 404 counts as empty).
 * - accept: POST -> 201 Task. dismiss: POST -> 204. A second review of the same suggestion -> 409.
 * - update: PATCH `UpdateTaskRequest` -> Task (partial; `null` clears description/assigneeId/dueAt).
 */
export { TASK_PATHS };
export type { UpdateTaskRequest };

/** Body of the accept route (API `AcceptExtractedTaskBody`; contracts has no named type yet). */
export type AcceptExtractedTaskRequest = {
  title: string;
  description?: string;
  priority: TaskPriority;
  dueAt?: string;
};

export type TaskReviewApi = {
  pending: (
    organizationId: Id,
    query?: { meetingId?: Id; cursor?: string },
  ) => Promise<Paginated<ExtractedTask>>;
  accept: (
    organizationId: Id,
    extractedTaskId: Id,
    body: AcceptExtractedTaskRequest,
  ) => Promise<Task>;
  dismiss: (organizationId: Id, extractedTaskId: Id) => Promise<void>;
  update: (organizationId: Id, taskId: Id, body: UpdateTaskRequest) => Promise<Task>;
};

type Request = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

export function createTaskReviewApi(request: Request): TaskReviewApi {
  const P = TASK_PATHS;
  return {
    pending: (organizationId, q) => {
      const qs = new URLSearchParams();
      if (q?.meetingId) qs.set('meetingId', q.meetingId);
      if (q?.cursor) qs.set('cursor', q.cursor);
      const s = qs.toString();
      return request('GET', fillPath(P.extractedTasks, { organizationId }) + (s ? `?${s}` : ''));
    },
    accept: (organizationId, extractedTaskId, body) =>
      request('POST', fillPath(P.accept, { organizationId, extractedTaskId }), body),
    dismiss: (organizationId, extractedTaskId) =>
      request('POST', fillPath(P.dismiss, { organizationId, extractedTaskId })),
    update: (organizationId, taskId, body) =>
      request('PATCH', fillPath(P.task, { organizationId, taskId }), body),
  };
}
