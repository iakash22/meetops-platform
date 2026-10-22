import { render, type RenderResult } from '@testing-library/react';
import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { App } from '@/app';
import type { ApiClient } from '@/lib/api/client';
import { useOrgStore, useUiStore } from '@/stores/org-store';
import {
  meeting1,
  meetings,
  orgs,
  projects,
  session,
  newOrg,
  sessionResponse,
  tasks,
  uploadResponse,
} from './data';

export function createMockApi(
  overrides: Partial<{
    [K in Exclude<keyof ApiClient, 'onUnauthorized'>]: Partial<ApiClient[K]>;
  }> & { onUnauthorized?: ApiClient['onUnauthorized'] } = {},
): ApiClient {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    onUnauthorized: overrides.onUnauthorized ?? vi.fn(() => () => {}),
    auth: {
      login: vi.fn().mockResolvedValue(session),
      signup: vi.fn().mockResolvedValue(session),
      forgotPassword: vi.fn().mockResolvedValue(undefined),
      session: vi.fn().mockResolvedValue(sessionResponse),
      switchOrganization: vi.fn((body: { organizationId: string }) =>
        Promise.resolve({ ...session, activeOrganizationId: body.organizationId }),
      ),
      ...overrides.auth,
    },
    organizations: {
      list: vi.fn().mockResolvedValue(orgs),
      create: vi.fn().mockResolvedValue({ organization: newOrg, role: 'owner' }),
      ...overrides.organizations,
    },
    meetings: {
      list: vi.fn().mockResolvedValue(meetings),
      get: vi.fn().mockResolvedValue(meeting1),
      ...overrides.meetings,
    },
    tasks: { list: vi.fn().mockResolvedValue(tasks), ...overrides.tasks },
    projects: { list: vi.fn().mockResolvedValue(projects), ...overrides.projects },
    storage: {
      createUpload: vi.fn().mockResolvedValue(uploadResponse),
      putToPresignedUrl: vi.fn().mockResolvedValue(undefined),
      ...overrides.storage,
    },
  };
}

export function resetStores(withOrgs = true) {
  useOrgStore.setState({
    organizations: withOrgs ? orgs : [],
    currentOrganizationId: withOrgs ? '00000000-0000-4000-8000-000000000001' : null,
  });
  useUiStore.setState({ sidebarOpen: true });
}

export type RenderAppResult = RenderResult & {
  api: ApiClient;
  history: RouterHistory;
  queryClient: QueryClient;
};

export function renderApp(path: string, api: ApiClient = createMockApi()): RenderAppResult {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const utils = render(<App queryClient={queryClient} api={api} history={history} />);
  return { ...utils, api, history, queryClient };
}
