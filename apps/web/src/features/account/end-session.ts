import { useCallback } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import { queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';

/**
 * Local sign-out once the server-side session is gone (revoked here, or every session
 * ended): go to /login, drop every cached query and reset the org store. Mirrors
 * SignOutControls so no data from the old session survives.
 */
export function useEndLocalSession() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const resetOrgs = useOrgStore((s) => s.reset);
  return useCallback(async () => {
    await router.navigate({ to: '/login', replace: true });
    queryClient.clear();
    queryClient.setQueryData<GetAuthSessionResponse | null>(queryKeys.session, null);
    resetOrgs();
  }, [router, queryClient, resetOrgs]);
}
