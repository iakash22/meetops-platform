import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useOrgStore } from '@/stores/org-store';
import { renderApp, resetStores } from './fixtures/render';

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
    expect(screen.getByRole('combobox', { name: 'Organization' })).toHaveValue('org_1');
  });

  it('switches organization via the placeholder switcher', async () => {
    renderApp('/');
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Organization' }),
      'org_2',
    );
    expect(useOrgStore.getState().currentOrgId).toBe('org_2');
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
