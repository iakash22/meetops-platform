import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';
import { orgs, sessionResponse } from './fixtures/data';

describe('app shell', () => {
  beforeEach(() => resetStores());

  it('renders sidebar nav, top bar and org switcher', async () => {
    renderApp('/');
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const label of ['Dashboard', 'Meetings', 'Tasks', 'Projects', 'Settings']) {
      expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveTextContent('Acme Inc');
    expect(await screen.findByLabelText('Signed in user')).toHaveTextContent('Ada');
  });

  it('switches organization via POST /orgs/switch, refetches the session and org data', async () => {
    const globex = '00000000-0000-4000-8000-000000000002';
    let active = sessionResponse.activeOrganizationId;
    const api = createMockApi({
      auth: {
        session: vi.fn(() => Promise.resolve({ ...sessionResponse, activeOrganizationId: active })),
      },
      organizations: {
        // The real API returns { organization, role } only (no AuthSession, no csrfToken).
        switch: vi.fn(({ organizationId }: { organizationId: string }) => {
          active = organizationId;
          return Promise.resolve({ organization: orgs[1]!, role: 'member' as const });
        }),
      },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(api.auth.session).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('combobox', { name: 'Organization' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Globex' }));
    await waitFor(() => expect(useOrgStore.getState().currentOrganizationId).toBe(globex));
    expect(api.organizations.switch).toHaveBeenCalledWith({ organizationId: globex });
    expect(api.auth.session).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(api.meetings.list).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002'),
    );
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveTextContent('Globex');
  });

  it('keeps the current org and shows an error when the switch fails', async () => {
    const api = createMockApi({
      organizations: {
        switch: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'no', 'req_1')),
      },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Organization' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Globex' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(useOrgStore.getState().currentOrganizationId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(api.auth.session).toHaveBeenCalledTimes(1);
  });

  it('falls back to the email when User.name is missing', async () => {
    const { name: _omit, ...noName } = sessionResponse.user;
    void _omit;
    renderApp(
      '/',
      createMockApi({
        auth: { session: vi.fn().mockResolvedValue({ ...sessionResponse, user: noName }) },
      }),
    );
    expect(await screen.findByLabelText('Signed in user')).toHaveTextContent('ada');
  });

  it('toggles the sidebar', async () => {
    renderApp('/');
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' });
    expect(sidebar).toHaveAttribute('data-state', 'open');
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(sidebar).toHaveAttribute('data-state', 'closed');
  });

  it('navigates between pages from the sidebar', async () => {
    const { history } = renderApp('/');
    await userEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(history.location.pathname).toBe('/settings');
  });
});
