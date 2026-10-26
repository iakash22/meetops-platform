import { render, type RenderResult } from '@testing-library/react';
import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { App } from '@/app';
import { useToastStore } from '@/components/ui/toast';
import type { Role } from '@meetops/contracts';
import { ApiError, type ApiClient, type CreateInvitationRequest } from '@/lib/api/client';
import { createMockDirectoryApi } from '@/features/directory/mock-api';
import { useOrgStore, useUiStore } from '@/stores/org-store';
import {
  meeting1,
  meetings,
  orgs,
  session,
  newOrg,
  sessionResponse,
  tasks,
  uploadResponse,
  pairResponse,
  sessionList,
  memberList,
  invitation,
} from './data';

export function createMockApi(
  overrides: Partial<{
    [K in Exclude<keyof ApiClient, 'onUnauthorized'>]: Partial<ApiClient[K]>;
  }> & { onUnauthorized?: ApiClient['onUnauthorized'] } = {},
): ApiClient {
  return {
    // Honour a passed-in request mock (e.g. a path-routed vi.fn) instead of always replacing it.
    request:
      (overrides.request as ApiClient['request'] | undefined) ??
      vi.fn().mockResolvedValue(undefined),
    onUnauthorized: overrides.onUnauthorized ?? vi.fn(() => () => {}),
    auth: {
      login: vi.fn().mockResolvedValue(session),
      signup: vi.fn().mockResolvedValue({ message: 'Check your email to continue.' }),
      forgotPassword: vi.fn().mockResolvedValue(undefined),
      resetPassword: vi.fn().mockResolvedValue(undefined),
      verifyEmail: vi.fn().mockResolvedValue(undefined),
      resendVerification: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      logoutAll: vi.fn().mockResolvedValue(undefined),
      session: vi.fn().mockResolvedValue(sessionResponse),
      sessions: vi.fn().mockResolvedValue(sessionList),
      revokeSession: vi.fn().mockResolvedValue(undefined),
      ...overrides.auth,
    },
    organizations: {
      list: vi.fn().mockResolvedValue({
        items: orgs.map((organization) => ({ organization, role: 'owner' })),
        nextCursor: null,
      }),
      create: vi.fn().mockResolvedValue({ organization: newOrg, role: 'owner' }),
      switch: vi.fn((body: { organizationId: string }) =>
        Promise.resolve({
          organization: orgs.find((o) => o.id === body.organizationId) ?? orgs[0]!,
          role: 'owner' as const,
        }),
      ),
      ...overrides.organizations,
    },
    invitations: {
      accept: vi.fn().mockResolvedValue({ organization: orgs[1]!, role: 'member' }),
      create: vi.fn((organizationId: string, body: CreateInvitationRequest) =>
        Promise.resolve({ ...invitation, organizationId, ...body }),
      ),
      revoke: vi.fn().mockResolvedValue({ ...invitation, status: 'revoked' }),
      ...overrides.invitations,
    },
    members: {
      list: vi.fn().mockResolvedValue(memberList),
      changeRole: vi.fn((organizationId: string, userId: string, role: Role) => {
        const m = memberList.items.find((x) => x.userId === userId) ?? memberList.items[0]!;
        return Promise.resolve({
          id: m.id,
          organizationId,
          userId,
          role,
          createdAt: m.createdAt,
        });
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      ...overrides.members,
    },
    extension: {
      pair: vi.fn().mockResolvedValue(pairResponse),
      ...overrides.extension,
    },
    desktop: {
      authorize: vi.fn().mockResolvedValue({ code: 'C'.repeat(43) }),
      ...overrides.desktop,
    },
    meetings: {
      list: vi.fn().mockResolvedValue(meetings),
      get: vi.fn().mockResolvedValue(meeting1),
      ...overrides.meetings,
    },
    tasks: { list: vi.fn().mockResolvedValue(tasks), ...overrides.tasks },
    meetingInsights: {
      transcript: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Not found')),
      report: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Not found')),
      ...overrides.meetingInsights,
    },
    // In-memory directory (empty); pass `directory: createMockDirectoryApi(seed)` to seed it.
    directory: { ...createMockDirectoryApi(), ...overrides.directory },
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
  useToastStore.setState({ toasts: [] });
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
