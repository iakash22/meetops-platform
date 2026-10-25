import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

describe('sign out (POST /auth/logout, /auth/logout-all)', () => {
  beforeEach(() => resetStores());

  async function openApp(api = createMockApi()) {
    const result = renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    return result;
  }

  it.each([
    ['Log out', 'logout'],
    ['Log out everywhere', 'logoutAll'],
  ] as const)('"%s" calls auth.%s, clears state and lands on /login', async (label, method) => {
    const api = createMockApi();
    const { history, queryClient } = await openApp(api);
    expect(useOrgStore.getState().currentOrganizationId).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: label }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(api.auth[method]).toHaveBeenCalledTimes(1);
    expect(api.auth[method === 'logout' ? 'logoutAll' : 'logout']).not.toHaveBeenCalled();
    expect(history.location.pathname).toBe('/login');
    expect(queryClient.getQueryData(['session'])).toBeNull();
    expect(queryClient.getQueryCache().findAll({ queryKey: ['meetings'] })).toHaveLength(0);
    expect(useOrgStore.getState()).toMatchObject({
      organizations: [],
      currentOrganizationId: null,
    });
  });

  it('treats a 401 (session already gone) as signed out', async () => {
    const api = createMockApi({
      auth: {
        logout: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'no', 'req_1')),
      },
    });
    const { history } = await openApp(api);
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(useOrgStore.getState().currentOrganizationId).toBeNull();
  });

  it('keeps the user signed in and shows the error when logout fails', async () => {
    const api = createMockApi({
      auth: {
        logoutAll: vi.fn().mockRejectedValue(new ApiError(503, 'INTERNAL', 'down', 'req_2')),
      },
    });
    const { history, queryClient } = await openApp(api);
    await userEvent.click(screen.getByRole('button', { name: 'Log out everywhere' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/meetings');
    expect(queryClient.getQueryData(['session'])).toBeTruthy();
    expect(useOrgStore.getState().currentOrganizationId).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
  });
});
