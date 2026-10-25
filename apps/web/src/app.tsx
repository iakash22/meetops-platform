import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { AppToaster } from '@/lib/errors/toaster';
import { ApiProvider } from '@/lib/api/context';
import type { ApiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/api/queries';
import { safeRedirect } from '@/lib/safe-redirect';
import { createAppRouter } from '@/routes/router';
import { useOrgStore } from '@/stores/org-store';

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

  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        <RouterProvider router={router} />
        <AppToaster />
      </ApiProvider>
    </QueryClientProvider>
  );
}
