import type { ExtractedTask, Task } from '@meetops/contracts';

import { AuthError } from '@/features/auth/auth-client';
import { invokeTokenFree, type Invoke } from '@/lib/native-auth';
import { createTaskReviewApi, type TaskReviewApi } from './task-review-core';

/** Task review through the Rust `api_request` command, so the bearer never reaches the webview. */
export function createNativeTaskReviewApi(invoke: Invoke): TaskReviewApi {
  return createTaskReviewApi((method, path, body) =>
    invokeTokenFree(
      invoke,
      'api_request',
      body === undefined ? { method, path } : { method, path, body },
    ),
  );
}

const ORG = '00000000-0000-4000-8000-000000000001';

/** Sample mode: two suggestions held in memory; same 409/404 rules as the API. */
export function createSampleTaskReviewApi(): TaskReviewApi {
  let pending: ExtractedTask[] = [1, 2].map((n) => ({
    id: `40000000-0000-4000-8000-00000000000${n}`,
    meetingId: '10000000-0000-4000-8000-000000000001',
    reportId: '30000000-0000-4000-8000-000000000001',
    title: n === 1 ? 'Share the launch checklist' : 'Follow up with design on icons',
    confidence: 0.8,
    sourceSegmentIds: [],
    createdAt: '2026-01-05T11:00:00.000Z',
  }));
  const tasks = new Map<string, Task>();
  const take = (id: string) => {
    const hit = pending.find((p) => p.id === id);
    if (!hit) throw new AuthError('CONFLICT', 'Already reviewed.');
    pending = pending.filter((p) => p.id !== id);
    return hit;
  };
  return {
    pending: async (org) => ({ items: org === ORG ? [...pending] : [], nextCursor: null }),
    accept: async (org, id, body) => {
      const src = take(id);
      const now = new Date().toISOString();
      const t: Task = {
        id: `5${src.id.slice(1)}`,
        organizationId: org,
        meetingId: src.meetingId,
        extractedTaskId: src.id,
        title: body.title,
        priority: body.priority,
        status: 'todo',
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(t.id, t);
      return t;
    },
    dismiss: async (_org, id) => {
      take(id);
    },
    update: async (_org, id, body) => {
      const t = tasks.get(id);
      if (!t) throw new AuthError('NOT_FOUND', 'Task not found.');
      const next = { ...t, updatedAt: new Date().toISOString() } as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      tasks.set(id, next as Task);
      return next as Task;
    },
  };
}
