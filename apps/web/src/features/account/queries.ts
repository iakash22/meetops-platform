import { useQuery } from '@tanstack/react-query';
import { useApi } from '@/lib/api/context';
import { fetchAllPages } from '@/lib/api/fetch-all';

export const accountKeys = {
  sessions: ['auth', 'sessions'] as const,
};

/** Every active session of the caller (GET /auth/sessions, all pages). Current one first. */
export function useMySessions() {
  const api = useApi();
  return useQuery({
    queryKey: accountKeys.sessions,
    queryFn: async () => {
      const { items, truncated } = await fetchAllPages((page) => api.auth.sessions(page));
      const sorted = [...items].sort(
        (a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
      return { items: sorted, truncated };
    },
  });
}
