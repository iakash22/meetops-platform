import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiProvider } from '@/lib/api/context';
import type { ApiClient } from '@/lib/api/client';
import { createAppRouter } from '@/routes/router';

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
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={api}>
        <RouterProvider router={router} />
      </ApiProvider>
    </QueryClientProvider>
  );
}
