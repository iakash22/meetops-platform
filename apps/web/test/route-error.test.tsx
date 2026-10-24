import { render, screen } from '@testing-library/react';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { vi } from 'vitest';
import { RouteError } from '@/routes/router';
import { describe, expect, it } from 'vitest';
import { isAuthOrUnavailable } from '@/features/session/use-session';
import { ApiError } from '@/lib/api/client';

describe('route error classification', () => {
  it('redirect-worthy: network, 401, 5xx', () => {
    expect(isAuthOrUnavailable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isAuthOrUnavailable(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe(true);
    expect(isAuthOrUnavailable(new ApiError(502, 'UNKNOWN', 'Request failed'))).toBe(true);
    expect(isAuthOrUnavailable(new ApiError(504, 'UNKNOWN', 'Request failed'))).toBe(true);
  });
  it('not redirect-worthy: app bugs and 4xx', () => {
    expect(isAuthOrUnavailable(new Error('render bug'))).toBe(false);
    expect(isAuthOrUnavailable(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false);
  });
});

describe('RouteError boundary (errorComponent path)', () => {
  function setup(err: unknown) {
    const root = createRootRoute({ component: Outlet, errorComponent: RouteError });
    const boom = createRoute({
      getParentRoute: () => root,
      path: '/meetings',
      component: () => {
        throw err;
      },
    });
    const login = createRoute({
      getParentRoute: () => root,
      path: '/login',
      component: () => <h1>Sign in</h1>,
    });
    const history = createMemoryHistory({ initialEntries: ['/meetings'] });
    const router = createRouter({ routeTree: root.addChildren([boom, login]), history });
    render(<RouterProvider router={router} />);
    return history;
  }

  it.each([
    ['502', new ApiError(502, 'UNKNOWN', 'Request failed')],
    ['504', new ApiError(504, 'UNKNOWN', 'Request failed')],
    ['network', new TypeError('Failed to fetch')],
  ])('%s thrown inside a route → /login?next=', async (_n, err) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const history = setup(err);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(history.location.href).toBe('/login?next=%2Fmeetings');
  });

  it('app bug renders the error state, no redirect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const history = setup(new Error('render bug'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(history.location.pathname).toBe('/meetings');
    expect(screen.queryByText('Something went wrong!')).not.toBeInTheDocument();
  });
});
