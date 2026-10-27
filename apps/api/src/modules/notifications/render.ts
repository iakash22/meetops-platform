import type { Notification } from '@meetops/contracts';

/** Stored shape (ids-only). Titles are never stored; they are rendered here from `type`. */
export interface StoredNotification {
  id: string;
  organizationId: string;
  type: string;
  subjectType: string | null;
  subjectId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** In-app copy per kind (en). Unknown kinds fall back to a generic title. Push never uses these (generic copy). */
export const NOTIFICATION_TITLES: Readonly<Record<string, string>> = {
  'task.assigned': 'A task was assigned to you',
  'tasks.ready_for_review': 'Tasks are ready for review',
  'meeting.summary_ready': 'Meeting summary is ready',
  'meeting.transcript_ready': 'Meeting transcript is ready',
  'integration.error': 'An integration needs attention',
  'member.added': 'You were added to the organization',
};
export const FALLBACK_NOTIFICATION_TITLE = 'New notification';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (n: StoredNotification, subject: string, key: string): string | undefined => {
  if (n.subjectType === subject && n.subjectId) return n.subjectId;
  const v = n.data[key];
  return typeof v === 'string' && UUID_RE.test(v) ? v : undefined;
};

export function renderNotification(n: StoredNotification): Notification {
  const meetingId = idOf(n, 'meeting', 'meetingId');
  const taskId = idOf(n, 'task', 'taskId');
  return {
    id: n.id,
    organizationId: n.organizationId,
    kind: n.type,
    title: NOTIFICATION_TITLES[n.type] ?? FALLBACK_NOTIFICATION_TITLE,
    ...(meetingId ? { meetingId } : {}),
    ...(taskId ? { taskId } : {}),
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}
