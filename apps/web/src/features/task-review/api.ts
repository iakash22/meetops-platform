import type { ExtractedTask, Id, Paginated, Task, TaskPriority } from '@meetops/contracts';
import type { HttpMethod } from '@/lib/api/client';

/**
 * Human review of AI-extracted tasks (Phase 4, task approval).
 *
 * BACKEND DEPENDENCY (All Rounder): contracts 0.4.x define ExtractedTask and Task but no review
 * routes. These are the proposed shapes; replace them with contracts path constants when they ship.
 * The UI treats 404 on the list as "nothing to review yet".
 */
export const TASK_REVIEW_PATHS = {
  pending: '/orgs/:organizationId/extracted-tasks',
  accept: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/accept',
  dismiss: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/dismiss',
} as const;

/** Body of the proposed accept route: the reviewer's edits; `assigneeHint` is never sent as an id. */
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
};

type Request = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

function fill(template: string, params: Record<string, string>): string {
  return template.replace(/:(\w+)/g, (_, k: string) => {
    const v = params[k];
    if (!v) throw new Error(`Missing path param ${k}`);
    return encodeURIComponent(v);
  });
}

export function createTaskReviewApi(request: Request): TaskReviewApi {
  const P = TASK_REVIEW_PATHS;
  return {
    pending: (organizationId, q) => {
      const qs = new URLSearchParams();
      if (q?.meetingId) qs.set('meetingId', q.meetingId);
      if (q?.cursor) qs.set('cursor', q.cursor);
      const s = qs.toString();
      return request('GET', fill(P.pending, { organizationId }) + (s ? `?${s}` : ''));
    },
    accept: (organizationId, extractedTaskId, body) =>
      request('POST', fill(P.accept, { organizationId, extractedTaskId }), body),
    dismiss: (organizationId, extractedTaskId) =>
      request('POST', fill(P.dismiss, { organizationId, extractedTaskId })),
  };
}
