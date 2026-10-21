import { render, type RenderResult } from '@testing-library/react';
import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { App } from '@/app';
import type { ApiClient } from '@/lib/api/client';
import { useOrgStore, useUiStore } from '@/stores/org-store';
import { meetings, orgs, projects, session, tasks } from './data';

export function createMockApi(
  overrides: Partial<{ [K in keyof ApiClient]: Partial<ApiClient[K]> }> = {},
): ApiClient {
  return {
    auth: {
      login: vi.fn().mockResolvedValue(session),
      signup: vi.fn().mockResolvedValue(session),
      forgotPassword: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides.auth,
    },
    organizations: { list: vi.fn().mockResolvedValue(orgs), ...overrides.organizations },
    meetings: { list: vi.fn().mockResolvedValue(meetings), ...overrides.meetings },
    tasks: { list: vi.fn().mockResolvedValue(tasks), ...overrides.tasks },
    projects: { list: vi.fn().mockResolvedValue(projects), ...overrides.projects },
    storage: {
      createUploadUrl: vi
        .fn()
        .mockResolvedValue({ url: 'https://x', expiresAt: new Date(), method: 'PUT' }),
      ...overrides.storage,
    },
  };
}

export function resetStores(withOrgs = true) {
  useOrgStore.setState({
    organizations: withOrgs ? orgs : [],
    currentOrgId: withOrgs ? 'org_1' : null,
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
