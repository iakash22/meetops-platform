import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ROLES } from '@meetops/contracts/types';
import type { Role } from '@meetops/contracts';
import { navItems, visibleNavItems } from '@/components/layout/nav-items';
import { canViewAnalytics } from '@/features/analytics/permissions';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { sessionResponse } from './fixtures/data';

const ANALYTICS_PREFIX = '/analytics/meetings?';

/** A session whose role in the active org is `role` (null: no membership, no active org). */
function apiAs(role: Role | null) {
  return createMockApi({
    request: vi.fn().mockResolvedValue(undefined),
    auth: {
      session: vi
        .fn()
        .mockResolvedValue(
          role
            ? { ...sessionResponse, role }
            : { ...sessionResponse, activeOrganizationId: null, role: null, organizations: [] },
        ),
    },
    ...(role ? {} : { organizations: { list: vi.fn().mockResolvedValue([]) } }),
  });
}

const analyticsCalls = (api: ReturnType<typeof createMockApi>) =>
  vi.mocked(api.request).mock.calls.filter(([, p]) => p.includes(ANALYTICS_PREFIX));

describe('canViewAnalytics (mirror of the API gate: CASL read Meeting)', () => {
  it('allows every membership role and nothing without one', () => {
    for (const role of ROLES) expect(canViewAnalytics(role)).toBe(true);
    expect(canViewAnalytics(null)).toBe(false);
    expect(canViewAnalytics(undefined)).toBe(false);
    expect(canViewAnalytics('guest' as Role)).toBe(false);
  });
  it('the nav entry and the route use the same check', () => {
    const entry = navItems.find((i) => i.to === '/analytics');
    expect(entry?.visibleFor).toBe(canViewAnalytics);
    expect(visibleNavItems(null).map((i) => i.to)).not.toContain('/analytics');
    // Only gated entries disappear; everything else is unchanged.
    expect(visibleNavItems(null)).toHaveLength(navItems.length - 1);
    expect(visibleNavItems('viewer')).toHaveLength(navItems.length);
  });
});

describe('Analytics nav entry per role', () => {
  beforeEach(() => resetStores());

  it.each(['owner', 'admin', 'member', 'viewer'] as const)(
    '%s sees Analytics in the main nav',
    async (role) => {
      renderApp('/', apiAs(role));
      const nav = await screen.findByRole('navigation', { name: 'Main' });
      expect(await within(nav).findByRole('link', { name: 'Analytics' })).toHaveAttribute(
        'href',
        '/analytics',
      );
    },
  );

  it('a user with no membership (no role in any org) does not see Analytics', async () => {
    resetStores(false);
    renderApp('/', apiAs(null));
    expect(await screen.findByText("You don't belong to an organization yet")).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Analytics' })).not.toBeInTheDocument();
  });

  it('the /analytics route agrees with the nav: no membership gets a not-available state and no request', async () => {
    resetStores(false);
    const api = apiAs(null);
    renderApp('/analytics', api);
    expect(await screen.findByText("Analytics aren't available")).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Date range' })).not.toBeInTheDocument();
    expect(analyticsCalls(api)).toHaveLength(0);
  });

  it('a viewer opening /analytics gets the dashboard request', async () => {
    const api = apiAs('viewer');
    renderApp('/analytics', api);
    expect(await screen.findByRole('group', { name: 'Date range' })).toBeInTheDocument();
    await vi.waitFor(() => expect(analyticsCalls(api)).toHaveLength(1));
  });
});
