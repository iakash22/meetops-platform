import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrgStore } from '@/stores/org-store';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { sessionResponse } from './fixtures/data';

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

  it('switches organization with the shadcn Select and refetches org data', async () => {
    const { api } = renderApp('/meetings');
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: 'Organization' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Globex' }));
    expect(useOrgStore.getState().currentOrganizationId).toBe('org_2');
    await waitFor(() => expect(api.meetings.list).toHaveBeenCalledWith('org_2'));
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveTextContent('Globex');
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
