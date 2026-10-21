import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';

export const SESSION_STALE_MS = 60_000;

/** Current cookie session from GET /auth/session (null when signed out). */
export function sessionQueryOptions(api: ApiClient) {
  return {
    queryKey: queryKeys.session,
    queryFn: async (): Promise<GetAuthSessionResponse | null> => {
      try {
        return await api.auth.session();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: SESSION_STALE_MS,
    retry: false,
  } as const;
}

export function useSession() {
  const api = useApi();
  return useQuery(sessionQueryOptions(api));
}

/** Load the session (cached) and sync organizations into the org store. */
export async function ensureSession(
  queryClient: QueryClient,
  api: ApiClient,
): Promise<GetAuthSessionResponse | null> {
  const session = await queryClient.ensureQueryData(sessionQueryOptions(api));
  if (session) applySessionToStore(session);
  return session;
}

export function applySessionToStore(
  session: Pick<GetAuthSessionResponse, 'organizations' | 'activeOrganizationId'>,
) {
  useOrgStore.getState().setOrganizations(session.organizations, session.activeOrganizationId);
}

/** Display name: optional `User.name`, else the email local part. */
export function displayName(user: { name?: string; email: string }): string {
  const name = user.name?.trim();
  return name ? name : (user.email.split('@')[0] ?? user.email);
}
