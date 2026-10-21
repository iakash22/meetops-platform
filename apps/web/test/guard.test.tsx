import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const unauthenticated = () =>
  vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'no session', 'r1'));

describe('auth guard', () => {
  beforeEach(() => resetStores(false));

  it('redirects signed-out users to /login?next=<path>', async () => {
    const { history } = renderApp(
      '/tasks?status=todo',
      createMockApi({ auth: { session: unauthenticated() } }),
    );
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/tasks?status=todo');
  });

  it('lets signed-in users through and loads orgs from the session', async () => {
    const { api } = renderApp('/meetings');
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(api.auth.session).toHaveBeenCalled();
    expect(useOrgStore.getState().currentOrganizationId).toBe('org_1');
  });

  it('redirects to /login?next= when any API call returns 401', async () => {
    let fire: () => void = () => {};
    const api = createMockApi({
      onUnauthorized: vi.fn((h: () => void) => {
        fire = h;
        return () => {};
      }),
    });
    const { history } = renderApp('/projects', api);
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    vi.mocked(api.auth.session).mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'x', 'r'));
    act(() => fire());
    await waitFor(() => expect(history.location.pathname).toBe('/login'));
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/projects');
    expect(useOrgStore.getState().currentOrganizationId).toBeNull();
  });
});
