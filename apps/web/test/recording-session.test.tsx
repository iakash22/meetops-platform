import { nonNotificationCalls } from './fixtures/route-ready';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApiClient } from '@/lib/api/client';
import {
  RECORDING_PATHS,
  RecordingSessionUploader,
  hexToBase64,
  sha256Hex,
  type SessionState,
} from '@/features/recording/session';
import { pickMimeType } from '@/features/recording/recording-panel';
import { meeting1 } from './fixtures/data';
import { renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

const ORG = '00000000-0000-4000-8000-000000000001';
const SID = '30000000-0000-4000-8000-000000000001';
const signed = (seq: number) => ({
  seq,
  upload: {
    url: `https://s3.example/c${seq}`,
    method: 'PUT',
    headers: { 'content-length': '3', 'x-amz-checksum-sha256': 'x' },
    expiresAt: '2026-10-26T00:00:00.000Z',
  },
});

function setup(fetchOk = true) {
  const request = vi.fn((_m: string, path: string, body?: unknown) => {
    if (path === RECORDING_PATHS.init(ORG)) return Promise.resolve({ sessionId: SID });
    if (path === RECORDING_PATHS.chunk(SID))
      return Promise.resolve(signed((body as { seq: number }).seq));
    if (path === RECORDING_PATHS.complete(SID)) return Promise.resolve({ status: 'uploaded' });
    return Promise.resolve(undefined);
  });
  const api = { request } as unknown as ApiClient;
  const doFetch = vi.fn().mockResolvedValue(new Response(null, { status: fetchOk ? 200 : 403 }));
  const states: SessionState[] = [];
  const u = new RecordingSessionUploader(api, ORG, (s) => states.push(s), doFetch);
  return { u, request, doFetch, states };
}

describe('RecordingSessionUploader', () => {
  it('hashes as lowercase hex and converts to base64', async () => {
    const hex = await sha256Hex(new Blob(['abc']));
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hexToBase64(hex)).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });

  it('inits with consent, uploads chunks in order, then completes', async () => {
    const { u, request, doFetch, states } = setup();
    await u.start({
      meetingId: meeting1.id,
      mimeType: 'audio/webm',
      consent: 'all_parties_consented',
    });
    expect(request).toHaveBeenCalledWith(
      'POST',
      RECORDING_PATHS.init(ORG),
      expect.objectContaining({
        source: 'tab',
        meetingId: meeting1.id,
        mimeType: 'audio/webm',
        consent: expect.objectContaining({
          consentVersion: '2026-11',
          method: 'all_parties_consented',
        }) as unknown,
      }),
    );
    u.push(new Blob(['abc']));
    u.push(new Blob(['def']));
    u.push(new Blob([]));
    await u.finish();
    const chunkCalls = request.mock.calls.filter((c) => c[1] === RECORDING_PATHS.chunk(SID));
    expect(chunkCalls.map((c) => (c[2] as { seq: number }).seq)).toEqual([0, 1]);
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://s3.example/c0');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'x-amz-checksum-sha256': 'x' });
    expect(request).toHaveBeenCalledWith(
      'POST',
      RECORDING_PATHS.complete(SID),
      expect.objectContaining({ chunkCount: 2 }),
    );
    expect(states.at(-1)).toEqual({ phase: 'done', status: 'uploaded' });
  });

  it('a failed chunk PUT errors and aborts the session', async () => {
    const { u, request, states } = setup(false);
    await u.start({
      meetingId: meeting1.id,
      mimeType: 'audio/webm',
      consent: 'all_parties_notified',
    });
    u.push(new Blob(['abc']));
    await u.finish();
    expect(states.at(-1)?.phase).toBe('error');
    expect(request).toHaveBeenCalledWith('POST', RECORDING_PATHS.abort(SID), { reason: 'error' });
    expect(request).not.toHaveBeenCalledWith(
      'POST',
      RECORDING_PATHS.complete(SID),
      expect.anything(),
    );
  });

  it('abort sends the reason', async () => {
    const { u, request, states } = setup();
    await u.start({
      meetingId: meeting1.id,
      mimeType: 'audio/webm',
      consent: 'all_parties_notified',
    });
    await u.abort('user_stopped');
    expect(request).toHaveBeenCalledWith('POST', RECORDING_PATHS.abort(SID), {
      reason: 'user_stopped',
    });
    expect(states.at(-1)).toEqual({ phase: 'aborted', reason: 'user_stopped' });
  });

  it('picks the first supported mime type', () => {
    expect(pickMimeType((t) => t === 'audio/webm')).toBe('audio/webm');
    expect(pickMimeType(() => false)).toBeNull();
  });
});

describe('RecordingPanel', () => {
  beforeEach(() => resetStores());

  it('falls back to a message when tab capture is unavailable (jsdom)', async () => {
    const { api } = renderApp(`/meetings/${meeting1.id}`);
    await waitForRouteData(api.meetings.get);
    await screen.findByRole('heading', { name: 'Record' });
    expect(screen.getByText(/supports tab capture/)).toBeInTheDocument();
  });

  it('requires consent before starting', async () => {
    vi.stubGlobal('MediaRecorder', Object.assign(vi.fn(), { isTypeSupported: () => true }));
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia },
      configurable: true,
    });
    try {
      const { api } = renderApp(`/meetings/${meeting1.id}`);
      await waitForRouteData(api.meetings.get);
      await userEvent.click(await screen.findByRole('button', { name: 'Start recording' }));
      expect(
        screen.getByText('Confirm how everyone was told about the recording.'),
      ).toBeInTheDocument();
      expect(getDisplayMedia).not.toHaveBeenCalled();
      getDisplayMedia.mockRejectedValue(new DOMException('no', 'NotAllowedError'));
      await userEvent.click(screen.getByLabelText(/was told it is recorded/));
      await userEvent.click(screen.getByRole('button', { name: 'Start recording' }));
      await waitFor(() => expect(getDisplayMedia).toHaveBeenCalled());
      expect(await screen.findByText('Recording not started')).toBeInTheDocument();
      expect(nonNotificationCalls(api.request)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });
});
