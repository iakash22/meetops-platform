import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { sessionList } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

const OTHER = sessionList.items[1]!;
const CURRENT = sessionList.items[0]!;

async function openAccount(api = createMockApi()) {
  const result = renderApp('/account', api);
  await waitForRouteData(api.auth.sessions, { heading: 'Account' });
  await screen.findAllByTestId('session-row');
  return result;
}

function expectSignedOut(r: Awaited<ReturnType<typeof openAccount>>) {
  expect(r.history.location.pathname).toBe('/login');
  expect(r.queryClient.getQueryData(['session'])).toBeNull();
  expect(useOrgStore.getState()).toMatchObject({ organizations: [], currentOrganizationId: null });
}

describe('/account', () => {
  beforeEach(() => resetStores());

  it('renders inside the guarded shell with profile basics', async () => {
    await openAccount();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    const profile = screen.getByTestId('profile');
    expect(within(profile).getByText('Ada')).toBeInTheDocument();
    expect(within(profile).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(profile).getByText('Acme Inc')).toBeInTheDocument();
    expect(within(profile).getByText('owner')).toBeInTheDocument();
  });

  it('redirects to /login when signed out', async () => {
    const api = createMockApi({
      auth: { session: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'x')) },
    });
    const { history } = renderApp('/account', api);
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(history.location.search).toContain('account');
    expect(api.auth.sessions).not.toHaveBeenCalled();
  });

  it('lists sessions, current first, as plain text', async () => {
    await openAccount();
    const rows = screen.getAllByTestId('session-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Firefox on macOS · Unknown location')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('This device')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/203\.0\.113\.7/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Safari on iOS · Unknown location')).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('This device')).toBeNull();
  });

  it('revokes another session after confirming, and refreshes the list', async () => {
    const r = await openAccount();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Safari on iOS' }));
    expect(r.api.auth.revokeSession).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect(await screen.findByText('Signed out Safari on iOS.')).toBeInTheDocument();
    expect(r.api.auth.revokeSession).toHaveBeenCalledWith(OTHER.id);
    await waitFor(() => expect(r.api.auth.sessions).toHaveBeenCalledTimes(2));
    expect(r.history.location.pathname).toBe('/account');
  });

  it('cancel leaves the session alone', async () => {
    const r = await openAccount();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Safari on iOS' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(r.api.auth.revokeSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke Safari on iOS' })).toBeInTheDocument();
  });

  it('revoking the current session signs this browser out', async () => {
    const r = await openAccount();
    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke Firefox on macOS (this device)' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sign out this device' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(r.api.auth.revokeSession).toHaveBeenCalledWith(CURRENT.id);
    expectSignedOut(r);
  });

  it('a 404 revoke says the session already ended', async () => {
    const api = createMockApi({
      auth: {
        revokeSession: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x')),
      },
    });
    await openAccount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Safari on iOS' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect(await screen.findByText('That session had already ended.')).toBeInTheDocument();
  });

  it('other revoke failures show a fixed message and keep the user signed in', async () => {
    const api = createMockApi({
      auth: {
        revokeSession: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'stack trace')),
      },
    });
    const r = await openAccount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Safari on iOS' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    expect(screen.queryByText('stack trace')).toBeNull();
    expect(r.history.location.pathname).toBe('/account');
  });

  it('shows an error state when sessions fail to load', async () => {
    const api = createMockApi({
      auth: { sessions: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'x')) },
    });
    renderApp('/account', api);
    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
  });

  it('log out all devices confirms, calls logout-all and clears local state', async () => {
    const r = await openAccount();
    await userEvent.click(screen.getByRole('button', { name: 'Log out all devices' }));
    expect(r.api.auth.logoutAll).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, log out all devices' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(r.api.auth.logoutAll).toHaveBeenCalledTimes(1);
    expectSignedOut(r);
  });

  it('a failed log out all devices keeps the user signed in', async () => {
    const api = createMockApi({
      auth: {
        logoutAll: vi.fn().mockRejectedValue(new ApiError(503, 'PROVIDER_UNAVAILABLE', 'x')),
      },
    });
    const r = await openAccount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Log out all devices' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, log out all devices' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(r.history.location.pathname).toBe('/account');
  });

  it('is reachable from the sidebar', async () => {
    const api = createMockApi();
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await userEvent.click(screen.getByRole('link', { name: 'Account' }));
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
  });
});
