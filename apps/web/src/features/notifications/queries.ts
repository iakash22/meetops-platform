import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/lib/api/context';
import { ApiError } from '@/lib/api/client';
import { useOrganizationId } from '@/lib/api/queries';
import { createNotificationsApi } from './api';

export const notificationKeys = {
  list: (organizationId: string) => ['orgs', organizationId, 'notifications'] as const,
};

/** 404 means the API has no notifications route yet: final, never retried. */
export const isNotAvailable = (err: unknown) => err instanceof ApiError && err.status === 404;

function useNotificationsApi() {
  const api = useApi();
  return createNotificationsApi(api.request);
}

export function useNotifications() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: notificationKeys.list(organizationId),
    queryFn: () => api.list(organizationId),
    enabled: !!organizationId,
    retry: (count, err) => !isNotAvailable(err) && count < 1,
  });
}

export function useMarkRead() {
  const api = useNotificationsApi();
  const organizationId = useOrganizationId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id?: string) =>
      id ? api.markRead(organizationId, id) : api.markAllRead(organizationId),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.list(organizationId) }),
  });
}
