import type { Id } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';

/**
 * In-app notifications (ADR-013), per the contract in PR #263 (@meetops/contracts v0.10.0,
 * api/notifications.ts). That PR is not merged into integration/phase-1, so these types and
 * paths are kept here IDENTICAL to it; swap to `@meetops/contracts` imports once #263 lands.
 */
export const NOTIFICATION_PATHS = {
  notifications: '/orgs/:organizationId/notifications',
  markRead: '/orgs/:organizationId/notifications/:notificationId/read',
  markAllRead: '/orgs/:organizationId/notifications/read-all',
  preferences: '/orgs/:organizationId/notification-preferences',
  pushDevices: '/me/push-devices',
  pushDevice: '/me/push-devices/:id',
} as const;

export const NOTIFICATION_CHANNELS = [
  'in_app',
  'email',
  'web_push',
  'mobile_push',
  'desktop',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Known kinds get friendly labels; any other kind renders as "New notification". */
export const KNOWN_NOTIFICATION_KINDS = [
  'meeting.processed',
  'transcript.ready',
  'report.ready',
  'task.assigned',
  'task.updated',
  'auth.new_location_signin',
] as const;

export type Notification = {
  id: Id;
  organizationId: Id;
  kind: string;
  title: string;
  body?: string;
  meetingId?: Id;
  taskId?: Id;
  readAt: string | null;
  createdAt: string;
  /**
   * CONTRACT NEED: `auth.new_location_signin` needs the sign-in city/country. Not in the v0.10.0
   * `Notification` schema yet; read here as optional extras until the contract adds them.
   */
  geoCity?: string | null;
  geoCountry?: string | null;
};
export type NotificationList = { items: Notification[]; nextCursor: string | null };
export type ListNotificationsQuery = { limit?: number; cursor?: string; unreadOnly?: boolean };
export type MarkNotificationsReadResponse = { updated: number };
export type NotificationPreference = {
  type: '*' | string;
  channel: NotificationChannel;
  enabled: boolean;
};
export type NotificationPreferences = { items: NotificationPreference[] };

export type NotificationsApi = {
  list: (organizationId: Id, query?: ListNotificationsQuery) => Promise<NotificationList>;
  markRead: (organizationId: Id, notificationId: Id) => Promise<MarkNotificationsReadResponse>;
  markAllRead: (organizationId: Id) => Promise<MarkNotificationsReadResponse>;
  getPreferences: (organizationId: Id) => Promise<NotificationPreferences>;
  putPreferences: (
    organizationId: Id,
    body: NotificationPreferences,
  ) => Promise<NotificationPreferences>;
};

const fill = (template: string, params: Record<string, string>) =>
  template.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));

function listQuery(q: ListNotificationsQuery = {}): string {
  const p = new URLSearchParams();
  if (q.cursor) p.set('cursor', q.cursor);
  if (q.limit !== undefined) p.set('limit', String(q.limit));
  if (q.unreadOnly) p.set('unreadOnly', 'true');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function createNotificationsApi(request: ApiClient['request']): NotificationsApi {
  return {
    list: (organizationId, query) =>
      request('GET', fill(NOTIFICATION_PATHS.notifications, { organizationId }) + listQuery(query)),
    markRead: (organizationId, notificationId) =>
      request('POST', fill(NOTIFICATION_PATHS.markRead, { organizationId, notificationId })),
    markAllRead: (organizationId) =>
      request('POST', fill(NOTIFICATION_PATHS.markAllRead, { organizationId })),
    getPreferences: (organizationId) =>
      request('GET', fill(NOTIFICATION_PATHS.preferences, { organizationId })),
    putPreferences: (organizationId, body) =>
      request('PUT', fill(NOTIFICATION_PATHS.preferences, { organizationId }), body),
  };
}

export const NEW_LOCATION_SIGNIN = 'auth.new_location_signin';

export function notificationTitle(
  n: Pick<Notification, 'kind' | 'title' | 'geoCity' | 'geoCountry'>,
): string {
  if (n.kind === NEW_LOCATION_SIGNIN) {
    const place = [n.geoCity, n.geoCountry]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .join(', ');
    return place ? `New sign-in from ${place}` : 'New sign-in from a new location';
  }
  return (KNOWN_NOTIFICATION_KINDS as readonly string[]).includes(n.kind)
    ? n.title
    : 'New notification';
}
