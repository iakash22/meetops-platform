import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { newOrg, sessionResponse } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

describe('create organization (E2E-07)', () => {
  beforeEach(() => resetStores());

  it('is reachable from the org switcher and switches to the new org', async () => {
    // Like the real API, the session rotates into the new org once it is created.
    let created = false;
    const api = createMockApi({
      auth: {
        session: vi.fn(() =>
          Promise.resolve(
            created
              ? {
                  ...sessionResponse,
                  activeOrganizationId: newOrg.id,
                  organizations: [...sessionResponse.organizations, newOrg],
                }
              : sessionResponse,
          ),
        ),
      },
      organizations: {
        create: vi.fn(() => {
          created = true;
          return Promise.resolve({ organization: newOrg, role: 'owner' as const });
        }),
      },
    });
    const { history } = renderApp('/meetings', api);
    await userEvent.click(await screen.findByRole('link', { name: 'Create organization' }));
    expect(history.location.pathname).toBe('/organizations/new');

    await userEvent.type(await screen.findByLabelText('Organization name'), '  Initech  ');
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));

    await waitFor(() => expect(history.location.pathname).toBe('/'));
    expect(api.organizations.create).toHaveBeenCalledWith({ name: 'Initech' });
    const state = useOrgStore.getState();
    expect(state.currentOrganizationId).toBe(newOrg.id);
    expect(state.organizations.map((o) => o.id)).toContain(newOrg.id);
    expect(await screen.findByRole('combobox', { name: 'Organization' })).toHaveTextContent(
      'Initech',
    );
  });

  it('validates the name with zod before calling the API', async () => {
    const api = createMockApi();
    renderApp('/organizations/new', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText('Organization name is required')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Organization name'), 'x'.repeat(201));
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(
      await screen.findByText('Organization name must be at most 200 characters'),
    ).toBeInTheDocument();
    expect(api.organizations.create).not.toHaveBeenCalled();
  });

  it('shows the API error with its reference and stays on the form', async () => {
    const api = createMockApi({
      organizations: {
        create: vi.fn().mockRejectedValue(new ApiError(409, 'CONFLICT', 'dup', 'req_42')),
      },
    });
    const { history } = renderApp('/organizations/new', api);
    await userEvent.type(await screen.findByLabelText('Organization name'), 'Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText(/Reference: req_42/)).toBeInTheDocument();
    expect(history.location.pathname).toBe('/organizations/new');
  });

  it('users with no organizations see a create CTA and a disabled switcher (E2E-06)', async () => {
    resetStores(false);
    const api = createMockApi({
      auth: {
        session: vi.fn().mockResolvedValue({
          ...sessionResponse,
          activeOrganizationId: null,
          role: null,
          organizations: [],
        }),
      },
      organizations: { list: vi.fn().mockResolvedValue([]) },
    });
    const { history } = renderApp('/', api);
    const empty = await screen.findByText("You don't belong to an organization yet");
    expect(screen.getByRole('combobox', { name: 'Organization' })).toBeDisabled();
    const cta = within(empty.closest('[data-testid="empty-state"]') as HTMLElement).getByRole(
      'link',
      { name: 'Create organization' },
    );
    await userEvent.click(cta);
    expect(history.location.pathname).toBe('/organizations/new');
  });
});
