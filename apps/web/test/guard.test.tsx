import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { isSignedOutForRouting } from '@/features/session/use-session';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

const unauthenticated = () =>
  vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'no session', 'r1'));

describe('auth guard', () => {
  beforeEach(() => resetStores(false));

  it('redirects signed-out users to /login?next=<path>', async () => {
    const { history } = renderApp(
      '/tasks?status=todo',
      createMockApi({ auth: { session: unauthenticated() } }),
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
    expect(new URLSearchParams(history.location.search).get('next')).toBe('/tasks?status=todo');
  });

  it('lets signed-in users through and loads orgs from the session', async () => {
    const { api } = renderApp('/meetings');
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(api.auth.session).toHaveBeenCalled();
    expect(useOrgStore.getState().currentOrganizationId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
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

  it.each([
    [
      'network error (fetch throws)',
      () => vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    ],
    [
      '503 from /auth/session',
      () => vi.fn().mockRejectedValue(new ApiError(503, 'PROVIDER_UNAVAILABLE', 'down', 'r503')),
    ],
    [
      '500 with unparseable body',
      () => vi.fn().mockRejectedValue(new ApiError(500, 'UNKNOWN', 'Request failed')),
    ],
  ])('redirects to /login?next= without crashing on %s', async (_label, makeSession) => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener('error', onError);
    const api = createMockApi({ auth: { session: makeSession() } });
    const { history } = renderApp(
      '/meetings/20000000-0000-4000-8000-000000000001?tab=summary',
      api,
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
    expect(new URLSearchParams(history.location.search).get('next')).toBe(
      '/meetings/20000000-0000-4000-8000-000000000001?tab=summary',
    );
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(api.meetings.get).not.toHaveBeenCalled();
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
  });

  it('does not loop when /login is opened while the API is down', async () => {
    const session = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { history } = renderApp('/login', createMockApi({ auth: { session } }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(history.location.href).toBe('/login');
    expect(session).not.toHaveBeenCalled();
  });

  it('still surfaces non-routing errors via the guard as signed-out (no crash)', async () => {
    const session = vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'x', 'r'));
    const { history } = renderApp('/tasks', createMockApi({ auth: { session } }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/login');
  });
});

describe('isSignedOutForRouting', () => {
  it('classifies errors', () => {
    expect(isSignedOutForRouting(new TypeError('Failed to fetch'))).toBe(true);
    expect(isSignedOutForRouting(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe(true);
    expect(isSignedOutForRouting(new ApiError(503, 'UNKNOWN', 'x'))).toBe(true);
    expect(isSignedOutForRouting(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false);
  });
});

describe('login after guard redirect (E2E-04)', () => {
  beforeEach(() => resetStores(false));

  it('protected page -> /login?next= -> login -> lands on the original page', async () => {
    const session = vi
      .fn()
      .mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'no session', 'r1'));
    const api = createMockApi({ auth: { session } });
    const { history } = renderApp('/meetings', api);
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(history.location.href).toBe('/login?next=%2Fmeetings');

    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(history.location.pathname).toBe('/meetings'));
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(useOrgStore.getState().currentOrganizationId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });
});
