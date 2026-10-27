import { GEO_TEXT_PATTERN, type Notification } from '@meetops/contracts';

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
  'auth.new_location_signin': 'New sign-in from a new location',
};
export const FALLBACK_NOTIFICATION_TITLE = 'New notification';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (n: StoredNotification, subject: string, key: string): string | undefined => {
  if (n.subjectType === subject && n.subjectId) return n.subjectId;
  const v = n.data[key];
  return typeof v === 'string' && UUID_RE.test(v) ? v : undefined;
};

/** ADR-014: only for new-location alerts, only values that pass the contracts GeoName rule (else omitted). */
const GEO_RE = new RegExp(GEO_TEXT_PATTERN);
function geoOf(n: StoredNotification): { geoCity?: string; geoCountry?: string } {
  if (n.type !== 'auth.new_location_signin') return {};
  const ok = (v: unknown): v is string =>
    typeof v === 'string' && v.length <= 128 && GEO_RE.test(v);
  return {
    ...(ok(n.data.geoCity) ? { geoCity: n.data.geoCity } : {}),
    ...(ok(n.data.geoCountry) ? { geoCountry: n.data.geoCountry } : {}),
  };
}

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
    ...geoOf(n),
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}
