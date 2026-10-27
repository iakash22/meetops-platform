import type { ExtractedTask, Task } from '@meetops/contracts';

import { ApiError, createApiRequester, type ApiClientOptions } from '../api/client';
import { createTaskReviewApi, TASK_PATHS, type TaskReviewApi } from './taskReviewCore';

/** Expected success status per call: accept 201, dismiss 204, reads and PATCH 200. */
function expectFor(method: string, path: string): number {
  if (method !== 'POST') return 200;
  return path.endsWith(TASK_PATHS.dismiss.split('/').pop() ?? 'dismiss') ? 204 : 201;
}

/** Task review over HTTP with the mobile Bearer (same requester as the other repositories). */
export function createHttpTaskReviewApi(options: ApiClientOptions): TaskReviewApi {
  const request = createApiRequester(options);
  return createTaskReviewApi((method, path, body) =>
    request(method, path, body, expectFor(method, path)),
  );
}

/** Demo mode: in-memory suggestions with the API's 409 (already reviewed) and 404 rules. */
export function createDemoTaskReviewApi(): TaskReviewApi {
  const T = '2026-10-21T09:00:00.000Z';
  const reviewed = new Set<string>();
  const tasks = new Map<string, Task>();
  const make = (n: number, title: string): ExtractedTask => ({
    id: `00000000-0000-4000-b000-00000000000${n}`,
    meetingId: '00000000-0000-4000-c000-000000000001',
    reportId: '00000000-0000-4000-d000-000000000001',
    title,
    confidence: 0.8,
    sourceSegmentIds: [],
    createdAt: T,
  });
  const review = (id: string) => {
    if (reviewed.has(id)) throw new ApiError(409, 'CONFLICT', 'Already reviewed.');
    reviewed.add(id);
  };
  return {
    async pending() {
      const items = [make(1, 'Share the meeting notes'), make(2, 'Book the follow-up call')].filter(
        (t) => !reviewed.has(t.id),
      );
      return { items, nextCursor: null };
    },
    async accept(organizationId, id, body) {
      review(id);
      const task: Task = {
        id: id.replace('b000', 'a000'),
        organizationId,
        title: body.title,
        priority: body.priority,
        status: 'todo',
        createdAt: T,
        updatedAt: T,
      };
      tasks.set(task.id, task);
      return task;
    },
    async dismiss(_org, id) {
      review(id);
    },
    async update(_org, taskId, body) {
      const t = tasks.get(taskId);
      if (!t) throw new ApiError(404, 'NOT_FOUND', 'Task not found.');
      const next = { ...t } as Task & Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      tasks.set(taskId, next);
      return next;
    },
  };
}
