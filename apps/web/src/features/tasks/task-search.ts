import { TASK_STATUSES, type TaskStatusValue } from '@meetops/contracts/types';

// Kept out of tasks-page.tsx so the router can validate ?search without loading the page chunk.
export { TASK_STATUSES };
export type TaskDueFilter = 'overdue' | 'today' | 'week';
export const TASK_DUE = ['overdue', 'today', 'week'] as const satisfies readonly TaskDueFilter[];
/** Assignee filter values: 'me', 'unassigned', or a user id. */
export type TaskSearch = { status?: TaskStatusValue; assignee?: string; due?: TaskDueFilter };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse untrusted URL search params into known filter values only. */
export function parseTaskSearch(search: Record<string, unknown>): TaskSearch {
  const out: TaskSearch = {};
  if (
    typeof search.status === 'string' &&
    (TASK_STATUSES as readonly string[]).includes(search.status)
  )
    out.status = search.status as TaskStatusValue;
  if (
    typeof search.assignee === 'string' &&
    (search.assignee === 'me' || search.assignee === 'unassigned' || UUID_RE.test(search.assignee))
  )
    out.assignee = search.assignee;
  if (typeof search.due === 'string' && (TASK_DUE as readonly string[]).includes(search.due))
    out.due = search.due as TaskDueFilter;
  return out;
}
