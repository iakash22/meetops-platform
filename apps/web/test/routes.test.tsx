import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';
import { createMockDirectoryApi } from '@/features/directory/mock-api';

describe('route tree', () => {
  beforeEach(() => resetStores());

  it.each([
    ['/login', 'Sign in'],
    ['/signup', 'Create account'],
    ['/forgot-password', 'Reset password'],
  ])('renders auth route %s outside the shell', async (path, heading) => {
    renderApp(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId('auth-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it.each([
    ['/', 'Dashboard'],
    ['/meetings', 'Meetings'],
    ['/tasks', 'Tasks'],
    ['/projects', 'Projects'],
    ['/settings', 'Settings'],
  ])('renders app route %s inside the shell', async (path, heading) => {
    renderApp(path);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('shows not found for unknown routes', async () => {
    renderApp('/nope');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('lists meetings from the api for the current org', async () => {
    const { api } = renderApp('/meetings');
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(api.meetings.list).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
  });

  it('shows tasks and projects', async () => {
    const { api } = renderApp('/tasks');
    await waitForRouteData(api.tasks.list, { heading: 'Tasks' });
    expect(await screen.findByText('Send recap')).toBeInTheDocument();
  });

  it('shows empty state when no meetings', async () => {
    renderApp(
      '/meetings',
      createMockApi({ meetings: { list: vi.fn().mockResolvedValue({ items: [] }) } }),
    );
    expect(await screen.findByText('No meetings yet')).toBeInTheDocument();
  });

  it('shows loading then error state when the api fails', async () => {
    let reject: (e: Error) => void = () => {};
    const pending = new Promise((_, r) => {
      reject = r;
    });
    const projects = {
      ...createMockDirectoryApi().projects,
      list: vi.fn().mockReturnValue(pending),
    };
    renderApp('/projects', createMockApi({ directory: { projects } }));
    expect(await screen.findByTestId('loading-state')).toBeInTheDocument();
    reject(new Error('Network down'));
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });
});
