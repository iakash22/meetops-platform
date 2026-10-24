import { TASK_STATUSES } from '@meetops/contracts/types';
import { useQuery } from '@tanstack/react-query';
import type { Id, Meeting, Paginated, Task, TaskUpdateEvent } from '@meetops/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { useApi } from './context';
import type { TaskListFilters } from './client';
import { useOrgStore } from '@/stores/org-store';

export const queryKeys = {
  session: ['session'] as const,
  organizations: ['organizations'] as const,
  meetings: (organizationId: Id) => ['orgs', organizationId, 'meetings'] as const,
  meeting: (organizationId: Id, meetingId: Id) =>
    ['orgs', organizationId, 'meetings', meetingId] as const,
  tasks: (organizationId: Id, filters: TaskListFilters = {}) =>
    ['orgs', organizationId, 'tasks', filters] as const,
  projects: (organizationId: Id) => ['orgs', organizationId, 'projects'] as const,
};

export function useOrganizationId(): Id {
  return useOrgStore((s) => s.currentOrganizationId) ?? '';
}

export function useMeetings() {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.meetings(organizationId),
    queryFn: () => api.meetings.list(organizationId),
    enabled: !!organizationId,
  });
}

export function useMeeting(meetingId: Id) {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery<Meeting>({
    queryKey: queryKeys.meeting(organizationId, meetingId),
    queryFn: () => api.meetings.get(organizationId, meetingId),
    enabled: !!organizationId && !!meetingId,
  });
}

export function useTasks(filters: TaskListFilters = {}) {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.tasks(organizationId, filters),
    queryFn: () => api.tasks.list(organizationId, filters),
    enabled: !!organizationId,
  });
}

export function useProjects() {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: queryKeys.projects(organizationId),
    queryFn: () => api.projects.list(organizationId),
    enabled: !!organizationId,
  });
}

/**
 * Merge a realtime `task.updated` event into every cached task page for that org.
 * Values are stored as plain data and rendered as text by React (never as HTML).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_KEYS = new Set([
  'organizationId',
  'taskId',
  'meetingId',
  'status',
  'title',
  'assigneeId',
  'at',
]);

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Strict ISO-8601 datetime with Z or ±HH:MM offset and a real calendar date. */
export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATETIME.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/**
 * Minimal runtime guard for contracts TaskUpdateEvent (avoids shipping the TypeBox
 * runtime): uuids, known status, title ≤ 500, ISO `at`, no extra keys.
 */
export function isTaskUpdateEvent(value: unknown): value is TaskUpdateEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (Object.keys(e).some((k) => !EVENT_KEYS.has(k))) return false;
  const isId = (v: unknown) => typeof v === 'string' && UUID.test(v);
  const optId = (v: unknown) => v === undefined || isId(v);
  return (
    isId(e.organizationId) &&
    isId(e.taskId) &&
    optId(e.meetingId) &&
    optId(e.assigneeId) &&
    typeof e.status === 'string' &&
    (TASK_STATUSES as readonly string[]).includes(e.status) &&
    (e.title === undefined || (typeof e.title === 'string' && e.title.length <= 500)) &&
    isIsoDateTime(e.at)
  );
}

/** Returns false (and changes nothing) for events that fail validation. */
export function applyTaskUpdate(queryClient: QueryClient, event: unknown): boolean {
  if (!isTaskUpdateEvent(event)) return false;
  queryClient.setQueriesData<Paginated<Task>>(
    { queryKey: ['orgs', event.organizationId, 'tasks'] },
    (page) =>
      page && {
        ...page,
        items: page.items.map((t) =>
          t.id === event.taskId
            ? {
                ...t,
                status: event.status,
                ...(event.title !== undefined ? { title: event.title } : {}),
                ...(event.assigneeId !== undefined ? { assigneeId: event.assigneeId } : {}),
              }
            : t,
        ),
      },
  );
  return true;
}
