import { useQuery } from '@tanstack/react-query';
import type { Id } from '@meetops/contracts';
import { useApi } from '@/lib/api/context';
import { fetchAllPages } from '@/lib/api/fetch-all';

export const memberKeys = {
  members: (organizationId: Id) => ['orgs', organizationId, 'members'] as const,
};

/** GET /orgs/:id/members (all pages). 404 when the caller is not a member of that org. */
export function useMembers(organizationId: Id | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: memberKeys.members(organizationId ?? ''),
    queryFn: () => fetchAllPages((page) => api.members.list(organizationId!, page)),
    enabled: !!organizationId,
  });
}
