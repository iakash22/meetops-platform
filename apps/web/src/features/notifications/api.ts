import type { Id, Paginated } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';

/**
 * In-app notification feed (ADR-013). NOT yet in @meetops/contracts or the API: these
 * shapes and paths are the web's proposal and live here (web-local) until contracts
 * ships them. The API answers 404 today; the UI shows that as "not available yet".
 */
export const NOTIFICATION_PATHS = {
  list: '/orgs/:organizationId/notifications',
  read: '/orgs/:organizationId/notifications/:notificationId/read',
  readAll: '/orgs/:organizationId/notifications/read-all',
} as const;

export type NotificationKind =
  'meeting.processed' | 'transcript.ready' | 'report.ready' | 'task.assigned' | 'task.updated';

/** Ids-only payload per ADR-013; text is rendered as plain text, never HTML. */
export type AppNotification = {
  id: Id;
  organizationId: Id;
  kind: NotificationKind | (string & {});
  title: string;
  body?: string;
  meetingId?: Id;
  taskId?: Id;
  readAt: string | null;
  createdAt: string;
};

export type NotificationsApi = {
  list: (organizationId: Id, cursor?: string) => Promise<Paginated<AppNotification>>;
  markRead: (organizationId: Id, notificationId: Id) => Promise<void>;
  markAllRead: (organizationId: Id) => Promise<void>;
};

const fill = (template: string, params: Record<string, string>) =>
  template.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));

export function createNotificationsApi(request: ApiClient['request']): NotificationsApi {
  return {
    list: (organizationId, cursor) =>
      request(
        'GET',
        fill(NOTIFICATION_PATHS.list, { organizationId }) +
          (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''),
      ),
    markRead: (organizationId, notificationId) =>
      request('POST', fill(NOTIFICATION_PATHS.read, { organizationId, notificationId })),
    markAllRead: (organizationId) =>
      request('POST', fill(NOTIFICATION_PATHS.readAll, { organizationId })),
  };
}
