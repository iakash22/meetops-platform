import type {
  ExtractedTask,
  Id,
  Paginated,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskRequest,
} from '@meetops/contracts';
import { TASK_PATHS } from '@meetops/contracts/types';

/**
 * Phase 4 task review on the task API (#222), contracts 0.8.0 `TASK_PATHS` (same flow as web #230).
 * - pending: GET extracted tasks awaiting review (an old 404 counts as empty).
 * - accept: POST -> 201 Task. dismiss: POST -> 204. A second review of the same suggestion -> 409.
 * - update: PATCH a minimal `UpdateTaskRequest` -> Task (`null` clears description/dueAt).
 */
export { TASK_PATHS };
export type { UpdateTaskRequest };

export type AcceptExtractedTaskRequest = {
  title: string;
  description?: string;
  priority: TaskPriority;
  dueAt?: string;
};

export type TaskReviewApi = {
  pending: (organizationId: Id) => Promise<Paginated<ExtractedTask>>;
  accept: (
    organizationId: Id,
    extractedTaskId: Id,
    body: AcceptExtractedTaskRequest,
  ) => Promise<Task>;
  dismiss: (organizationId: Id, extractedTaskId: Id) => Promise<void>;
  update: (organizationId: Id, taskId: Id, body: UpdateTaskRequest) => Promise<Task>;
};

export type ReviewSend = <T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
) => Promise<T>;

/** Fills `:param` segments, URL-encoding each value; throws on a missing param. */
export function fillTaskPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_w, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`Missing path param ${key}`);
    return encodeURIComponent(v);
  });
}

export function createTaskReviewApi(send: ReviewSend): TaskReviewApi {
  const P = TASK_PATHS;
  return {
    pending: (organizationId) =>
      send('GET', `${fillTaskPath(P.extractedTasks, { organizationId })}?limit=50`),
    accept: (organizationId, extractedTaskId, body) =>
      send('POST', fillTaskPath(P.accept, { organizationId, extractedTaskId }), body),
    dismiss: async (organizationId, extractedTaskId) => {
      await send('POST', fillTaskPath(P.dismiss, { organizationId, extractedTaskId }));
    },
    update: (organizationId, taskId, body) =>
      send('PATCH', fillTaskPath(P.task, { organizationId, taskId }), body),
  };
}

export const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
export const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export type EditValues = {
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  /** `YYYY-MM-DD`, or '' for no due date. */
  due: string;
};
export type EditField = 'title' | 'description' | 'dueAt';
export type FieldErrors = Partial<Record<EditField | 'form', string>>;

export function toEditValues(t: Task): EditValues {
  return {
    title: t.title,
    description: t.description ?? '',
    priority: t.priority,
    status: t.status,
    due: t.dueAt ? t.dueAt.slice(0, 10) : '',
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Mirrors UpdateTaskRequest: title 1–500, description ≤ 10,000, ISO date. */
export function validateEdit(v: EditValues): FieldErrors {
  const e: FieldErrors = {};
  const title = v.title.trim();
  if (!title) e.title = 'Enter a title.';
  else if (title.length > 500) e.title = 'Keep the title under 500 characters.';
  if (v.description.length > 10_000)
    e.description = 'Keep the description under 10,000 characters.';
  if (v.due && (!DATE_RE.test(v.due) || Number.isNaN(Date.parse(`${v.due}T00:00:00Z`))))
    e.dueAt = 'Enter a date as YYYY-MM-DD.';
  return e;
}

/** Only changed keys; '' clears description/dueAt with `null`. `{}` means nothing changed. */
export function buildUpdate(task: Task, v: EditValues): UpdateTaskRequest {
  const before = toEditValues(task);
  const body: UpdateTaskRequest = {};
  const title = v.title.trim();
  if (title !== before.title) body.title = title;
  if (v.description !== before.description)
    body.description = v.description.trim() ? v.description : null;
  if (v.priority !== before.priority) body.priority = v.priority;
  if (v.status !== before.status) body.status = v.status;
  if (v.due !== before.due) body.dueAt = v.due ? `${v.due}T00:00:00.000Z` : null;
  return body;
}

/** Copy for a server 400/422 on a known field (`/title`, `/description`, `/dueAt`). */
export function fieldErrorsFromPaths(paths: readonly string[]): FieldErrors | null {
  const copy: Record<EditField, string> = {
    title: 'Enter a valid title.',
    description: "This description isn't valid.",
    dueAt: 'Enter a valid date.',
  };
  const out: FieldErrors = {};
  for (const p of paths) {
    const k = p.replace(/^\//, '').split('/')[0] as EditField;
    if (k in copy) out[k] = copy[k];
  }
  return Object.keys(out).length ? out : null;
}
