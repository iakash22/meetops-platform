import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/api/context';
import { ApiError } from '@/lib/api/client';
import { useOrganizationId } from '@/lib/api/queries';
import { createNotificationsApi, type NotificationPreferences } from './api';

export const notificationKeys = {
  all: (organizationId: string) => ['orgs', organizationId, 'notifications'] as const,
  list: (organizationId: string) => ['orgs', organizationId, 'notifications', 'list'] as const,
  unread: (organizationId: string) => ['orgs', organizationId, 'notifications', 'unread'] as const,
  preferences: (organizationId: string) =>
    ['orgs', organizationId, 'notification-preferences'] as const,
};

/** 404 means this API build has no notifications routes yet: final, never retried. */
export const isNotAvailable = (err: unknown) => err instanceof ApiError && err.status === 404;
const retry = (count: number, err: unknown) => !isNotAvailable(err) && count < 1;

function useNotificationsApi() {
  return createNotificationsApi(useApi().request);
}

export function useNotifications() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: notificationKeys.list(organizationId),
    queryFn: () => api.list(organizationId),
    enabled: !!organizationId,
    retry,
  });
}

/** No unreadCount in the contract: count the first unreadOnly page (max 100, shown as 99+). */
export function useUnreadNotifications() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: notificationKeys.unread(organizationId),
    queryFn: () => api.list(organizationId, { unreadOnly: true, limit: 100 }),
    enabled: !!organizationId,
    retry: false,
  });
}

/** Mark one (id) or all read. The API is idempotent, so a repeat click is harmless. */
export function useMarkRead() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) =>
      id ? api.markRead(organizationId, id) : api.markAllRead(organizationId),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all(organizationId) }),
  });
}

export function useNotificationPreferences() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: notificationKeys.preferences(organizationId),
    queryFn: () => api.getPreferences(organizationId),
    enabled: !!organizationId,
    retry,
  });
}

export function useSaveNotificationPreferences() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPreferences) => api.putPreferences(organizationId, body),
    onSuccess: (data) => qc.setQueryData(notificationKeys.preferences(organizationId), data),
  });
}
