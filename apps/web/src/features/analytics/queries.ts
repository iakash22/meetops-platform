import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/lib/api/context';
import { ApiError } from '@/lib/api/client';
import { useOrganizationId } from '@/lib/api/queries';
import { createAnalyticsApi, type AnalyticsQuery } from './api';

export const analyticsKeys = {
  meetings: (organizationId: string, q: AnalyticsQuery) =>
    ['orgs', organizationId, 'analytics', 'meetings', q.from, q.to, q.bucket ?? 'day'] as const,
};

/** 404 means this API build has no analytics route yet (or no access): final, never retried. */
export const isNotAvailable = (err: unknown) => err instanceof ApiError && err.status === 404;
const retry = (count: number, err: unknown) => !isNotAvailable(err) && count < 1;

export function useMeetingAnalytics(query: AnalyticsQuery, { enabled = true } = {}) {
  const api = createAnalyticsApi(useApi().request);
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: analyticsKeys.meetings(organizationId, query),
    queryFn: () => api.meetings(organizationId, query),
    enabled: enabled && !!organizationId,
    retry,
  });
}
