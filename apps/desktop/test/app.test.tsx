import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { App } from '@/app';
import { createMockAuthClient } from '@/features/auth/mock-auth';

function renderApp() {
  const user = userEvent.setup();
  render(<App authClient={createMockAuthClient({ delayMs: 0 })} />);
  return user;
}

async function signIn(user: ReturnType<typeof userEvent.setup>, email = 'alex@example.com') {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('desktop app shell', () => {
  it('shows the mocked sign-in screen first', () => {
    renderApp();
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/sign-in is mocked/i)).toBeInTheDocument();
  });

  it('validates empty credentials without calling the client', async () => {
    const user = renderApp();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your email and password.');
  });

  it('shows the auth error for rejected credentials', async () => {
    const user = renderApp();
    await signIn(user, 'someone@invalid.test');
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.queryByRole('list', { name: 'Meetings' })).not.toBeInTheDocument();
  });

  it('signs in to the meetings list, navigates to settings and signs out', async () => {
    const user = renderApp();
    await signIn(user);

    const list = await screen.findByRole('list', { name: 'Meetings' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Signed in user')).toHaveTextContent('Alex');
    expect(screen.getByText('Demo Organization')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new offline recording/i })).toBeDisabled();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: /meetings/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(nav).getByRole('button', { name: /settings/i }));

    expect(await screen.findByText('Browser preview')).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: /settings/i })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('collapsible sidebar', () => {
  it('collapses to icons and expands again, keeping nav labels accessible', async () => {
    window.localStorage.clear();
    const user = renderApp();
    await signIn(user);
    await screen.findByRole('list', { name: 'Meetings' });

    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    await user.click(collapse);
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    // Labels remain available to assistive tech while visually hidden.
    const nav = within(sidebar).getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: /settings/i })).toBeInTheDocument();
    expect(window.localStorage.getItem('meetops.desktop.sidebarCollapsed')).toBe('1');

    await user.click(expand);
    expect(sidebar).toHaveAttribute('data-collapsed', 'false');
  });
});
