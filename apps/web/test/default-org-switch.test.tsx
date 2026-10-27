import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { orgs, sessionResponse } from './fixtures/data';

const ACME = orgs[0]!.id;

describe('default organization after login', () => {
  beforeEach(() => resetStores(false));

  it('switches to the fallback org and refetches the session before loading meetings', async () => {
    let active: string | null = null;
    const order: string[] = [];
    const api = createMockApi({
      auth: {
        session: vi.fn(() => {
          order.push(`session:${active}`);
          return Promise.resolve({ ...sessionResponse, activeOrganizationId: active as never });
        }),
      },
      organizations: {
        switch: vi.fn(({ organizationId }: { organizationId: string }) => {
          order.push(`switch:${organizationId}`);
          active = organizationId;
          return Promise.resolve({ organization: orgs[0]!, role: 'owner' as const });
        }),
      },
    });
    const list = api.meetings.list as ReturnType<typeof vi.fn>;
    list.mockImplementation((id: string) => {
      order.push(`meetings:${id}`);
      return id === active
        ? Promise.resolve({ items: [], nextCursor: null })
        : Promise.reject(new ApiError(404, 'NOT_FOUND', 'no', 'r'));
    });
    renderApp('/meetings', api);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(api.organizations.switch).toHaveBeenCalledWith({ organizationId: ACME });
    expect(order.slice(0, 4)).toEqual([
      'session:null',
      `switch:${ACME}`,
      `session:${ACME}`,
      `meetings:${ACME}`,
    ]);
    expect(useOrgStore.getState().currentOrganizationId).toBe(ACME);
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });

  it('does not switch when the session already has the active org', async () => {
    const api = createMockApi();
    renderApp('/meetings', api);
    await waitFor(() => expect(api.meetings.list).toHaveBeenCalled());
    expect(api.organizations.switch).not.toHaveBeenCalled();
  });

  it('stays signed in if the switch fails', async () => {
    const api = createMockApi({
      auth: {
        session: vi.fn().mockResolvedValue({ ...sessionResponse, activeOrganizationId: null }),
      },
      organizations: { switch: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'x', 'r')) },
    });
    renderApp('/meetings', api);
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(api.organizations.switch).toHaveBeenCalledTimes(1);
  });
});
