import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { GetAuthSessionResponse } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { queryKeys } from '@/lib/api/queries';
import { useOrgStore } from '@/stores/org-store';

export const SESSION_STALE_MS = 60_000;

/**
 * Errors that mean "no usable session" for routing: 401, API unreachable
 * (fetch throws, e.g. TypeError: Failed to fetch) or a 5xx. The user is sent to
 * /login instead of the app crashing.
 */
export function isSignedOutForRouting(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 401 || e.status >= 500 || e.status === 0;
  return true; // network / abort / unexpected non-API error
}

/** Stricter check for route error boundaries: only auth/availability failures, never app bugs. */
export function isAuthOrUnavailable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 401 || e.status >= 500 || e.status === 0;
  return e instanceof TypeError; // fetch() network failure (ECONNREFUSED, aborted, DNS)
}

/** Current cookie session from GET /auth/session (null when signed out). */
export function sessionQueryOptions(api: ApiClient) {
  return {
    queryKey: queryKeys.session,
    queryFn: async (): Promise<GetAuthSessionResponse | null> => {
      try {
        return await api.auth.session();
      } catch (e) {
        if (isSignedOutForRouting(e)) return null;
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

/**
 * Load the session (cached) and sync organizations into the org store.
 *
 * The API scopes `/orgs/:id/...` to the session's active org. When the session has no active org
 * (or one the user no longer belongs to) the store falls back to a default org; that choice is made
 * real with POST /orgs/switch and a session refetch BEFORE any org-scoped data loads, otherwise
 * every org route answers 404.
 */
export async function ensureSession(
  queryClient: QueryClient,
  api: ApiClient,
): Promise<GetAuthSessionResponse | null> {
  const session = await queryClient.ensureQueryData(sessionQueryOptions(api));
  if (!session) return null;
  applySessionToStore(session);
  return syncDefaultOrganization(queryClient, api, session);
}

let pendingSwitch: Promise<GetAuthSessionResponse | null> | null = null;

/** If the store's org differs from the session's active org, switch server-side and refetch. */
export async function syncDefaultOrganization(
  queryClient: QueryClient,
  api: ApiClient,
  session: GetAuthSessionResponse,
): Promise<GetAuthSessionResponse | null> {
  const chosen = useOrgStore.getState().currentOrganizationId;
  if (!chosen || chosen === session.activeOrganizationId) return session;
  // One switch at a time (guard + concurrent callers share it).
  pendingSwitch ??= (async () => {
    try {
      await api.organizations.switch({ organizationId: chosen });
      const fresh = await queryClient.fetchQuery({ ...sessionQueryOptions(api), staleTime: 0 });
      if (fresh) applySessionToStore(fresh);
      return fresh;
    } catch {
      // Keep the user signed in; org-scoped pages show their own error state with retry.
      return session;
    } finally {
      pendingSwitch = null;
    }
  })();
  return pendingSwitch;
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
