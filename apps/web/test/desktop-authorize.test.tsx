import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import {
  buildCallbackUrl,
  toDesktopAuthorizeRequest,
  validateLoopbackRedirect,
} from '@/features/desktop/authorize';
import { describeDesktopAuthorizeError } from '@/features/desktop/authorize-errors';
import { desktopRedirect } from '@/features/desktop/authorize-page';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const state = 's'.repeat(43);
const challenge = 'c'.repeat(43);
const deviceId = '00000000-0000-4000-8000-0000000000dd';
const redirect = 'http://127.0.0.1:53111/callback';
const params = {
  state,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  redirect_uri: redirect,
  device_id: deviceId,
  device_label: 'Studio Mac',
};
const path = `/desktop/authorize?${new URLSearchParams(params).toString()}`;

describe('desktop authorize helpers (ADR-012 §1.5)', () => {
  it('accepts only http://127.0.0.1:<port>/callback', () => {
    expect(validateLoopbackRedirect(redirect)).toBe(redirect);
    for (const bad of [
      'http://localhost:53111/callback',
      'https://127.0.0.1:53111/callback',
      'http://0.0.0.0:53111/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:53111/other',
      'http://127.0.0.1:53111/callback?x=1',
      'http://127.0.0.1:53111/callback#f',
      'http://u:p@127.0.0.1:53111/callback',
      'javascript:alert(1)',
    ]) {
      expect(validateLoopbackRedirect(bad)).toBeNull();
    }
  });

  it('rejects malformed params and drops an unsafe label', () => {
    expect(toDesktopAuthorizeRequest({ ...params, code_challenge_method: 'plain' })).toBeNull();
    expect(toDesktopAuthorizeRequest({ ...params, state: 'short' })).toBeNull();
    expect(toDesktopAuthorizeRequest({ ...params, device_id: 'x' })).toBeNull();
    expect(toDesktopAuthorizeRequest({ ...params, device_label: '<b>' })).not.toHaveProperty(
      'deviceLabel',
    );
  });

  it('builds the callback URL with code and state', () => {
    expect(buildCallbackUrl(redirect, 'k'.repeat(43), state)).toBe(
      `${redirect}?code=${'k'.repeat(43)}&state=${state}`,
    );
  });

  it('never surfaces server text', () => {
    const f = describeDesktopAuthorizeError(new ApiError(404, 'NOT_FOUND', 'server text'));
    expect(f.title).toBe('Desktop sign-in unavailable');
    expect(f.message).not.toContain('server text');
  });
});

describe('/desktop/authorize page', () => {
  beforeEach(() => resetStores());
  afterEach(() => vi.restoreAllMocks());

  it('shows user, org and device and calls the API only after confirmation', async () => {
    const assign = vi.spyOn(desktopRedirect, 'assign').mockImplementation(() => {});
    const { api } = renderApp(path);
    expect(await screen.findByTestId('desktop-org')).toHaveTextContent('Acme Inc');
    expect(await screen.findByTestId('desktop-device')).toHaveTextContent('Studio Mac');
    expect(await screen.findByTestId('desktop-user')).not.toHaveTextContent('Unknown user');
    expect(api.desktop.authorize).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Allow desktop sign-in' }));
    expect(await screen.findByTestId('desktop-redirecting')).toBeInTheDocument();
    expect(api.desktop.authorize).toHaveBeenCalledWith({
      state,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      redirectUri: redirect,
      deviceId,
      deviceLabel: 'Studio Mac',
    });
    expect(assign).toHaveBeenCalledWith(`${redirect}?code=${'C'.repeat(43)}&state=${state}`);
  });

  it('handles the route not being served yet (404) without redirecting', async () => {
    const assign = vi.spyOn(desktopRedirect, 'assign').mockImplementation(() => {});
    const api = createMockApi({
      desktop: { authorize: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x', 'r-1')) },
    });
    renderApp(path, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Allow desktop sign-in' }));
    expect(await screen.findByText('Desktop sign-in unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('request-id')).toHaveTextContent('r-1');
    expect(assign).not.toHaveBeenCalled();
  });

  it('offers retry on network errors and rejects a malformed code', async () => {
    const assign = vi.spyOn(desktopRedirect, 'assign').mockImplementation(() => {});
    const authorize = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ code: 'bad' });
    renderApp(path, createMockApi({ desktop: { authorize } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow desktop sign-in' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Unexpected response')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('cancel sends nothing', async () => {
    const { api } = renderApp(path);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('desktop-cancelled')).toBeInTheDocument();
    expect(api.desktop.authorize).not.toHaveBeenCalled();
  });

  it('shows an invalid-link notice for a non-loopback redirect', async () => {
    renderApp(path.replace(encodeURIComponent('127.0.0.1'), 'evil.example'));
    expect(await screen.findByText('Invalid sign-in link')).toBeInTheDocument();
  });
});
