import { TASK_PATHS } from '@meetops/contracts/types';
import { fillPath } from './api-paths.js';

/** Popup -> background: count of AI-extracted tasks awaiting review (contracts 0.8.0 TASK_PATHS). */
export interface PendingTasksRequest {
  target: 'background';
  type: 'TASKS_PENDING';
}
export type PendingTasks = { count: number; more: boolean };
export type PendingTasksResponse = ({ ok: true } & PendingTasks) | { ok: false; error: string };

/** Page size of the count read; a further page shows as "50+". */
export const PENDING_LIMIT = 50;
/** Web page that hosts the review flow (#230). */
export const WEB_REVIEW_PATH = '/tasks/review';

export function isPendingTasksRequest(msg: unknown): msg is PendingTasksRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.target === 'background' && m.type === 'TASKS_PENDING';
}

export const reviewUrl = (webOrigin: string) => `${webOrigin}${WEB_REVIEW_PATH}`;

export function pendingLabel(p: PendingTasks): string {
  const n = p.more ? `${p.count}+` : String(p.count);
  return p.count === 1 && !p.more ? '1 task to review' : `${n} tasks to review`;
}

/**
 * Reads the first page of extracted tasks through the bearer `apiFetch` (API origin only). An API without the
 * route yet (404) counts as zero; any other failure throws so the popup can hide the row.
 */
export async function fetchPendingTasks(
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>,
  organizationId: string,
): Promise<PendingTasks> {
  const path = `${fillPath(TASK_PATHS.extractedTasks, { organizationId })}?limit=${PENDING_LIMIT}`;
  const res = await apiFetch(path, { method: 'GET', headers: { accept: 'application/json' } });
  if (res.status === 404) return { count: 0, more: false };
  if (!res.ok) throw new Error(`API ${res.status}`);
  const body: unknown = await res.json();
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new Error('API response failed schema validation');
  const next = (body as { nextCursor?: unknown }).nextCursor;
  return { count: items.length, more: typeof next === 'string' && next.length > 0 };
}
