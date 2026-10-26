import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INTEGRATIONS_PATHS,
  createHttpIntegrationsApi,
  createMockIntegrationsApi,
  safeAuthorizeUrl,
  setIntegrationsApiOverride,
  validateTarget,
} from '@/features/integrations/api';
import { oauthRedirect } from '@/features/integrations/integrations-panel';
import { parseSettingsSearch } from '@/features/settings/settings-search';
import { renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';

describe('integrations api helpers', () => {
  it('validates targets per provider', () => {
    expect(validateTarget('github', 'acme/web')).toBeNull();
    expect(validateTarget('github', 'acme')).toMatch(/owner\/repo/);
    expect(validateTarget('jira', 'OPS')).toBeNull();
    expect(validateTarget('jira', 'ops')).toMatch(/project key/);
    expect(validateTarget('jira', '')).toBeNull();
  });
  it('only follows https authorize urls', () => {
    expect(safeAuthorizeUrl('https://github.com/login/oauth/authorize?x=1')).toMatch(/^https:/);
    expect(safeAuthorizeUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizeUrl('http://github.com')).toBeNull();
  });
  it('http client hits the planned routes', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const api = createHttpIntegrationsApi(request);
    await api.list(ORG);
    await api.update(ORG, 'jira', { defaultTarget: 'OPS' });
    await api.disconnect(ORG, 'github');
    expect(request.mock.calls).toEqual([
      ['GET', INTEGRATIONS_PATHS.list(ORG)],
      ['PATCH', INTEGRATIONS_PATHS.item(ORG, 'jira'), { defaultTarget: 'OPS' }],
      ['DELETE', INTEGRATIONS_PATHS.item(ORG, 'github')],
    ]);
  });
  it('settings accepts ?tab=integrations', () => {
    expect(parseSettingsSearch({ tab: 'integrations' })).toEqual({ tab: 'integrations' });
  });
});

async function renderPanel() {
  const navigate = vi.spyOn(oauthRedirect, 'assign').mockImplementation(() => undefined);
  renderApp('/settings?tab=integrations');
  await screen.findByRole('heading', { name: 'Settings' });
  return navigate;
}

describe('IntegrationsPanel', () => {
  beforeEach(() => resetStores());
  afterEach(() => {
    setIntegrationsApiOverride(null);
    vi.restoreAllMocks();
  });

  it('connect redirects to the server OAuth url', async () => {
    setIntegrationsApiOverride(createMockIntegrationsApi());
    const navigate = await renderPanel();
    const jira = await screen.findByTestId('integration-jira');
    expect(within(jira).getByText('Not connected')).toBeInTheDocument();
    await userEvent.click(within(jira).getByRole('button', { name: 'Connect Jira' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('https://example.com/oauth/jira/authorize?state=mock'),
    );
  });

  it('saves the default target with inline validation, and disconnects', async () => {
    setIntegrationsApiOverride(
      createMockIntegrationsApi({
        github: { id: 'g1', status: 'connected', accountLabel: 'acme' },
      }),
    );
    await renderPanel();
    const gh = await screen.findByTestId('integration-github');
    expect(within(gh).getByText('acme')).toBeInTheDocument();
    const input = within(gh).getByLabelText('Default repository');
    await userEvent.type(input, 'nope');
    await userEvent.click(within(gh).getByRole('button', { name: 'Save' }));
    expect(within(gh).getByRole('alert')).toHaveTextContent('owner/repo');
    await userEvent.clear(input);
    await userEvent.type(input, 'acme/web');
    await userEvent.click(within(gh).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('GitHub settings saved')).toBeInTheDocument();
    await userEvent.click(within(gh).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('GitHub disconnected')).toBeInTheDocument();
    expect(await within(gh).findByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument();
  });

  it('a non-https authorize url is refused with a toast', async () => {
    const mock = createMockIntegrationsApi();
    mock.connect = () => Promise.resolve({ authorizeUrl: 'javascript:alert(1)' });
    setIntegrationsApiOverride(mock);
    const navigate = await renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    expect(await screen.findByText("Couldn't connect GitHub")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
