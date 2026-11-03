import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { ApiProvider } from '@/lib/api/context';
import type { ApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/queries';
import { isRealtimeEnabled } from '@/lib/realtime/flag';
import { safeRedirect } from '@/lib/safe-redirect';
import { createAppRouter } from '@/routes/router';
import { useOrgStore } from '@/stores/org-store';

// Loaded on demand so the realtime client is not in the initial bundle (and never fetched with the flag off).
const RealtimeBridge = lazy(() =>
  import('@/lib/realtime/bridge').then((m) => ({ default: m.RealtimeBridge })),
);

export function App({
  queryClient,
  api,
  history,
}: {
  queryClient: QueryClient;
  api: ApiClient;
  history?: RouterHistory;
}) {
  const [router] = useState(() => createAppRouter({ queryClient, api }, history));

  // Any 401 from the API (outside auth endpoints) ends the session client-side.
  useEffect(
    () =>
      api.onUnauthorized(() => {
        const here = router.state.location.href;
        if (router.state.location.pathname === '/login') return;
        queryClient.setQueryData(queryKeys.session, null);
        queryClient.removeQueries({ queryKey: ['orgs'] });
        useOrgStore.getState().reset();
        void router.navigate({ to: '/login', search: { next: safeRedirect(here, '/') } });
      }),
    [api, queryClient, router],
  );

  const checkSession = useCallback(
    () =>
      api.auth.session().then(
        () => true,
        () => false,
      ),
    [api],
  );
  const realtimeOn = isRealtimeEnabled();

  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        {realtimeOn && (
          <Suspense fallback={null}>
            <RealtimeBridge checkSession={checkSession} />
          </Suspense>
        )}
        <RouterProvider router={router} />
        <Toaster />
      </ApiProvider>
    </QueryClientProvider>
  );
}
