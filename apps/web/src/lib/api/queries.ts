import { TASK_STATUSES } from '@meetops/contracts/types';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  Id,
  Meeting,
  MeetingStatusEvent,
  Paginated,
  Task,
  TaskUpdateEvent,
} from '@meetops/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useApi } from './context';
import { ApiError, type TaskListFilters } from './client';
import { useOrgStore } from '@/stores/org-store';
import { useRealtimeStore } from '@/lib/realtime/store';

export const queryKeys = {
  session: ['session'] as const,
  organizations: ['organizations'] as const,
  meetings: (organizationId: Id) => ['orgs', organizationId, 'meetings'] as const,
  meetingsList: (organizationId: Id) => ['orgs', organizationId, 'meetings', 'list'] as const,
  meeting: (organizationId: Id, meetingId: Id) =>
    ['orgs', organizationId, 'meetings', meetingId] as const,
  tasks: (organizationId: Id, filters: TaskListFilters = {}) =>
    ['orgs', organizationId, 'tasks', filters] as const,
};

export function useOrganizationId(): Id {
  return useOrgStore((s) => s.currentOrganizationId) ?? '';
}

/**
 * GET /orgs/:id/meetings, newest first, cursor-paginated. The first page omits `cursor`
 * (server default limit 25); `fetchNextPage` follows `nextCursor` until it is null.
 */
const IN_FLIGHT = new Set<Meeting['status']>(['recording', 'processing']);
/** Poll every 5s while a meeting is recording or processing; stop once it settles. */
export const MEETING_POLL_MS = 5_000;
/** While realtime is connected, polling drops to a slow safety net (missed events, server restarts). */
export const MEETING_POLL_REALTIME_MS = 30_000;
export function meetingPollInterval(
  status: Meeting['status'] | undefined,
  realtimeConnected = false,
): number | false {
  if (!status || !IN_FLIGHT.has(status)) return false;
  return realtimeConnected ? MEETING_POLL_REALTIME_MS : MEETING_POLL_MS;
}

const useRealtimeConnected = () => useRealtimeStore((s) => s.status === 'connected');

export function useMeetings() {
  const api = useApi();
  const organizationId = useOrganizationId();
  const live = useRealtimeConnected();
  return useInfiniteQuery({
    queryKey: queryKeys.meetingsList(organizationId),
    queryFn: ({ pageParam }) =>
      pageParam
        ? api.meetings.list(organizationId, { cursor: pageParam })
        : api.meetings.list(organizationId),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Paginated<Meeting>) => last.nextCursor,
    enabled: !!organizationId,
    refetchInterval: (q) =>
      meetingPollInterval(
        q.state.data?.pages.some((p) => p.items.some((m) => IN_FLIGHT.has(m.status)))
          ? 'processing'
          : undefined,
        live,
      ),
  });
}

/** 400/403/404 will not change on retry (404 is the same for missing and other-org ids). */
const isFinalClientError = (err: unknown) =>
  err instanceof ApiError && (err.status === 400 || err.status === 403 || err.status === 404);

export function useMeeting(meetingId: Id) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const live = useRealtimeConnected();
  return useQuery<Meeting>({
    queryKey: queryKeys.meeting(organizationId, meetingId),
    queryFn: () => api.meetings.get(organizationId, meetingId),
    enabled: !!organizationId && !!meetingId,
    retry: (count, err) => !isFinalClientError(err) && count < 1,
    // Poll while the pipeline is running so status, transcript and summary appear without a reload.
    // realtime `meeting:status` patches the cache; polling stays as the fallback.
    refetchInterval: (q) => meetingPollInterval(q.state.data?.status, live),
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

const MEETING_STATUSES = new Set<Meeting['status']>([
  'scheduled',
  'recording',
  'processing',
  'completed',
  'failed',
]);
const MEETING_EVENT_KEYS = new Set(['organizationId', 'meetingId', 'status', 'at', 'errorCode']);

/** Minimal runtime guard for contracts MeetingStatusEvent (strict keys, uuids, known status). */
export function isMeetingStatusEvent(value: unknown): value is MeetingStatusEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (Object.keys(e).some((k) => !MEETING_EVENT_KEYS.has(k))) return false;
  const isId = (v: unknown) => typeof v === 'string' && UUID.test(v);
  return (
    isId(e.organizationId) &&
    isId(e.meetingId) &&
    typeof e.status === 'string' &&
    MEETING_STATUSES.has(e.status as Meeting['status']) &&
    (e.errorCode === undefined || (typeof e.errorCode === 'string' && e.errorCode.length <= 64)) &&
    isIsoDateTime(e.at)
  );
}

/**
 * Apply a realtime `meeting:status` event to the cached meeting and meeting-list pages.
 * On a terminal status the meeting is invalidated so transcript and summary are refetched.
 * Returns false (and changes nothing) for events that fail validation.
 */
export function applyMeetingStatus(queryClient: QueryClient, event: unknown): boolean {
  if (!isMeetingStatusEvent(event)) return false;
  const { organizationId, meetingId, status } = event;
  const detailKey = queryKeys.meeting(organizationId, meetingId);
  queryClient.setQueryData<Meeting>(detailKey, (m) => (m ? { ...m, status } : m));
  queryClient.setQueryData<InfiniteData<Paginated<Meeting>>>(
    queryKeys.meetingsList(organizationId),
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((p) => ({
          ...p,
          items: p.items.map((m) => (m.id === meetingId ? { ...m, status } : m)),
        })),
      },
  );
  if (!IN_FLIGHT.has(status)) void queryClient.invalidateQueries({ queryKey: detailKey });
  return true;
}
