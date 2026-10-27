import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Integration } from '@meetops/contracts';
import {
  CONNECT_RETURN_TO,
  createHttpIntegrationsApi,
  createMockIntegrationsApi,
  currentByProvider,
  safeAuthorizeUrl,
  setIntegrationsApiOverride,
} from '@/features/integrations/api';
import { oauthRedirect } from '@/features/integrations/integrations-panel';
import { parseSettingsSearch } from '@/features/settings/settings-search';
import { sessionResponse } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const T = '2026-10-01T00:00:00.000Z';
const gh = (over: Partial<Integration> = {}): Integration => ({
  id: '70000000-0000-4000-8000-000000000001',
  organizationId: ORG,
  provider: 'github',
  status: 'active',
  displayName: 'acme',
  externalAccountId: '42',
  connectedById: '10000000-0000-4000-8000-000000000001',
  createdAt: T,
  updatedAt: T,
  ...over,
});

describe('integrations api helpers', () => {
  it('only follows https authorize urls', () => {
    expect(safeAuthorizeUrl('https://github.com/login/oauth/authorize?x=1')).toMatch(/^https:/);
    expect(safeAuthorizeUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizeUrl('http://github.com')).toBeNull();
  });
  it('http client hits the contracts routes', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const api = createHttpIntegrationsApi(request);
    await api.list(ORG);
    await api.connect(ORG, 'jira');
    await api.disconnect(ORG, 'a/b');
    expect(request.mock.calls).toEqual([
      ['GET', `/orgs/${ORG}/integrations`],
      [
        'POST',
        `/orgs/${ORG}/integrations/connect`,
        { provider: 'jira', returnTo: CONNECT_RETURN_TO },
      ],
      ['DELETE', `/orgs/${ORG}/integrations/a%2Fb`],
    ]);
  });
  it('picks the current connection per provider, skipping revoked', () => {
    const r = currentByProvider([
      gh({ status: 'revoked', updatedAt: '2026-10-09T00:00:00.000Z' }),
      gh({ id: '70000000-0000-4000-8000-000000000002', status: 'error' }),
    ]);
    expect(r.github?.status).toBe('error');
    expect(r.jira).toBeNull();
  });
  it('settings accepts ?tab=integrations', () => {
    expect(parseSettingsSearch({ tab: 'integrations' })).toEqual({ tab: 'integrations' });
  });
});

async function renderPanel(role: 'owner' | 'member' = 'owner') {
  const navigate = vi.spyOn(oauthRedirect, 'assign').mockImplementation(() => undefined);
  renderApp(
    '/settings?tab=integrations',
    role === 'owner'
      ? undefined
      : createMockApi({
          auth: { session: vi.fn().mockResolvedValue({ ...sessionResponse, role }) },
        }),
  );
  await screen.findByRole('heading', { name: 'Settings' });
  return navigate;
}

describe('IntegrationsPanel', () => {
  beforeEach(() => resetStores());
  afterEach(() => {
    setIntegrationsApiOverride(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lists connections; connect is flagged off by default', async () => {
    setIntegrationsApiOverride(createMockIntegrationsApi([gh()]));
    await renderPanel();
    const g = await screen.findByTestId('integration-github');
    expect(within(g).getByText('Connected')).toBeInTheDocument();
    expect(within(g).getByText('acme')).toBeInTheDocument();
    const jira = screen.getByTestId('integration-jira');
    expect(within(jira).getByText('Not connected')).toBeInTheDocument();
    expect(within(jira).getByText(/coming soon/)).toBeInTheDocument();
    expect(within(jira).queryByRole('button', { name: 'Connect Jira' })).not.toBeInTheDocument();
  });

  it('with the flag on, connect redirects to the server OAuth url', async () => {
    vi.stubEnv('VITE_INTEGRATION_CONNECT', 'true');
    setIntegrationsApiOverride(createMockIntegrationsApi());
    const navigate = await renderPanel();
    const jira = await screen.findByTestId('integration-jira');
    await userEvent.click(within(jira).getByRole('button', { name: 'Connect Jira' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://example.com/oauth/jira/authorize?state=mock'),
    );
  });

  it('refuses a non-https authorize url with a toast', async () => {
    vi.stubEnv('VITE_INTEGRATION_CONNECT', 'true');
    const mock = createMockIntegrationsApi();
    mock.connect = () => Promise.resolve({ authorizeUrl: 'javascript:alert(1)', expiresAt: T });
    setIntegrationsApiOverride(mock);
    const navigate = await renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText("Couldn't connect GitHub")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('disconnect asks for confirmation first', async () => {
    const mock = createMockIntegrationsApi([gh()]);
    const spy = vi.spyOn(mock, 'disconnect');
    setIntegrationsApiOverride(mock);
    await renderPanel();
    const g = await screen.findByTestId('integration-github');
    await userEvent.click(within(g).getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect GitHub?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(spy).not.toHaveBeenCalled();
    await userEvent.click(within(g).getByRole('button', { name: 'Disconnect' }));
    const again = await screen.findByRole('dialog', { name: 'Disconnect GitHub?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('GitHub disconnected')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(ORG, gh().id);
    await waitFor(() => expect(within(g).getByText('Not connected')).toBeInTheDocument());
  });

  it('members see connections but no connect or disconnect', async () => {
    vi.stubEnv('VITE_INTEGRATION_CONNECT', 'true');
    setIntegrationsApiOverride(createMockIntegrationsApi([gh()]));
    await renderPanel('member');
    const g = await screen.findByTestId('integration-github');
    expect(within(g).getByText('acme')).toBeInTheDocument();
    expect(screen.getByText(/Only owners and admins/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });
});
