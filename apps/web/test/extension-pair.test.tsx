import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAIRING_CODE_MESSAGE_TYPE } from '@meetops/contracts/types';
import { ApiError } from '@/lib/api/client';
import { buildPairingMessage, toPairRequest } from '@/features/extension/pairing';
import { pairResponse } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const extensionId = 'a'.repeat(32);
const deviceId = '00000000-0000-4000-8000-0000000000dd';
const nonce = 'N'.repeat(43);
const path = `/extension/pair?extensionId=${extensionId}&deviceId=${deviceId}&nonce=${nonce}&deviceLabel=Work%20laptop`;

type Cb = (r: unknown) => void;
function installChrome(
  impl: (id: string, msg: unknown, cb: Cb) => void,
  lastError?: { message: string },
) {
  const runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    lastError?: { message: string } | undefined;
  } = {
    sendMessage: vi.fn((id: string, msg: unknown, cb: Cb) => {
      runtime.lastError = lastError;
      impl(id, msg, cb);
    }),
  };
  (globalThis as { chrome?: unknown }).chrome = { runtime };
  return runtime;
}

describe('pairing helpers', () => {
  it('builds the strict PairingCodeMessage with exactly three keys', () => {
    expect(buildPairingMessage('c'.repeat(40), nonce)).toEqual({
      type: PAIRING_CODE_MESSAGE_TYPE,
      pairingCode: 'c'.repeat(40),
      nonce,
    });
    expect(PAIRING_CODE_MESSAGE_TYPE).toBe('MEETOPS_PAIRING_CODE');
  });

  it('rejects malformed params and drops an unsafe device label', () => {
    expect(toPairRequest({ extensionId: 'zz', deviceId, nonce })).toBeNull();
    expect(toPairRequest({ extensionId, deviceId: 'x', nonce })).toBeNull();
    expect(toPairRequest({ extensionId, deviceId, nonce: 'short' })).toBeNull();
    expect(toPairRequest({ extensionId, deviceId, nonce, deviceLabel: '<b>' })).toEqual({
      extensionId,
      deviceId,
      nonce,
    });
  });
});

describe('/extension/pair (ADR-005)', () => {
  beforeEach(() => resetStores());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('redirects signed-out users to /login keeping the pairing params', async () => {
    const api = createMockApi({
      auth: { session: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'x')) },
    });
    resetStores(false);
    const { history } = renderApp(path, api);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(new URLSearchParams(history.location.search).get('next')).toBe(path.replace('%20', '+'));
  });

  it('confirms org and device, pairs, and sends the message to the extension', async () => {
    const runtime = installChrome((_id, _m, cb) => cb({ ok: true }));
    const { api } = renderApp(path);
    expect(await screen.findByTestId('pair-org')).toHaveTextContent('Acme Inc');
    expect(screen.getByTestId('pair-device')).toHaveTextContent('Work laptop');
    expect(api.extension.pair).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Connect extension' }));
    expect(await screen.findByTestId('pair-success')).toHaveTextContent('Acme Inc');
    expect(api.extension.pair).toHaveBeenCalledWith({
      extensionId,
      deviceId,
      nonce,
      deviceLabel: 'Work laptop',
    });
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      extensionId,
      { type: 'MEETOPS_PAIRING_CODE', pairingCode: pairResponse.pairingCode, nonce },
      expect.any(Function),
    );
  });

  it('shows a notice when chrome.runtime is missing and never calls the API', async () => {
    const { api } = renderApp(path);
    expect(await screen.findByText('Extension not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect extension' })).toBeNull();
    expect(api.extension.pair).not.toHaveBeenCalled();
  });

  it('shows an invalid-link notice for malformed params', async () => {
    installChrome(() => {});
    renderApp('/extension/pair?extensionId=bad');
    expect(await screen.findByText('Invalid pairing link')).toBeInTheDocument();
  });

  it('maps API errors through the envelope messages', async () => {
    const runtime = installChrome((_i, _m, cb) => cb(undefined));
    const api = createMockApi({
      extension: {
        pair: vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'server text', 'req-9')),
      },
    });
    renderApp(path, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect extension' }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
    expect(screen.getByTestId('request-id')).toHaveTextContent('req-9');
    expect(screen.queryByText('server text')).toBeNull();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('reports an unreachable extension (runtime.lastError)', async () => {
    installChrome((_i, _m, cb) => cb(undefined), { message: 'Could not establish connection' });
    renderApp(path);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect extension' }));
    expect(await screen.findByText("Couldn't reach the extension")).toBeInTheDocument();
    expect(screen.queryByTestId('pair-success')).toBeNull();
  });

  it('shows a loading state while pairing', async () => {
    installChrome((_i, _m, cb) => cb(undefined));
    let resolve!: (v: typeof pairResponse) => void;
    const api = createMockApi({
      extension: { pair: vi.fn(() => new Promise<typeof pairResponse>((r) => (resolve = r))) },
    });
    renderApp(path, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect extension' }));
    expect(screen.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
    resolve(pairResponse);
    await waitFor(() => expect(screen.getByTestId('pair-success')).toBeInTheDocument());
  });
});
