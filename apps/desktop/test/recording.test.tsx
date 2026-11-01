import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/app';
import { createMockAuthClient } from '@/features/auth/mock-auth';
import type { Recorder } from '@/features/recording/recorder';
import type { RecordingDeps } from '@/features/recording/recording-screen';
import {
  createMemoryChunkStore,
  createUploadQueue,
  type RecordingUploadApi,
} from '@/features/recording/upload-queue';
import { AuthError } from '@/features/auth/auth-client';

function fakeRecorder() {
  let emit: ((b: Uint8Array) => void) | null = null;
  const rec: Recorder & { emit: (b: Uint8Array) => void; stopped: boolean } = {
    mimeType: 'audio/webm;codecs=opus',
    stopped: false,
    start: (cb) => {
      emit = cb;
      return Promise.resolve();
    },
    pause: vi.fn(),
    resume: vi.fn(),
    stop: () => {
      rec.stopped = true;
      return Promise.resolve();
    },
    emit: (b) => emit?.(b),
  };
  return rec;
}

function setup(
  api: Partial<RecordingUploadApi> = {},
  mic: 'granted' | 'denied' | 'prompt' = 'granted',
  failPutFromSeq: number | null = null,
) {
  const fullApi: RecordingUploadApi = {
    init: vi.fn(() => Promise.resolve({ sessionId: 's1' })),
    chunkUrl: vi.fn((_sessionId: string, body: { seq: number }) =>
      Promise.resolve({
        upload: {
          method: 'PUT' as const,
          url: 'https://u.test/x',
          headers: { 'content-length': '1' },
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
        seq: body.seq,
      }),
    ),
    put: vi.fn(() => Promise.resolve()),
    complete: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
    ...api,
  };
  const mem = createMemoryChunkStore();
  const chunks = {
    ...mem,
    put: (id: string, seq: number, b: Uint8Array) =>
      failPutFromSeq !== null && seq >= failPutFromSeq
        ? Promise.reject(Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }))
        : mem.put(id, seq, b),
  };
  const queue = createUploadQueue(fullApi, chunks, {
    isOnline: () => true,
    identity: () => ({
      userId: '00000000-0000-4000-8000-000000000002',
      organizationId: '00000000-0000-4000-8000-000000000001',
    }),
  });
  const rec = fakeRecorder();
  const deps: RecordingDeps = {
    queue,
    chunks,
    makeRecorder: () => rec,
    simulated: false,
    queryMic: () => Promise.resolve(mic),
  };
  const user = userEvent.setup();
  render(<App authClient={createMockAuthClient({ delayMs: 0 })} recording={deps} />);
  return { user, rec, api: fullApi, queue };
}

async function toRecord(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'alex@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await user.click(await screen.findByRole('button', { name: /new offline recording/i }));
  await screen.findByRole('heading', { name: 'Record' });
}

describe('desktop recording', () => {
  it('requires opt-in and participant notice before recording', async () => {
    const { user } = setup();
    await toRecord(user);
    expect(screen.getByLabelText('Meeting')).toHaveDisplayValue('Sprint planning');
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('dialog', { name: 'Turn on recording?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn on recording' }));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByText(/confirm that everyone/i)).toBeInTheDocument();
    expect(screen.queryByTestId('recording-indicator')).not.toBeInTheDocument();
  });

  it('records, pauses, stops and uploads with the consent attestation', async () => {
    const { user, rec, api } = setup();
    await toRecord(user);
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Turn on recording' }));
    await user.click(screen.getByLabelText(/i told everyone/i));
    await user.click(screen.getByLabelText(/everyone also agreed/i));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByTestId('recording-indicator')).toHaveTextContent('Recording');
    act(() => rec.emit(new Uint8Array([1, 2, 3])));
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(rec.pause).toHaveBeenCalled();
    expect(screen.getByTestId('recording-indicator')).toHaveTextContent('Paused');
    await user.click(screen.getByRole('button', { name: 'Stop and save' }));
    expect(rec.stopped).toBe(true);
    await waitFor(() => expect(api.complete).toHaveBeenCalled());
    const init = vi.mocked(api.init).mock.calls[0]!;
    expect(init[1]).toMatchObject({
      source: 'desktop',
      meetingId: '10000000-0000-4000-8000-000000000003',
      consent: { method: 'all_parties_consented' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('queue-summary')).toHaveTextContent('Nothing waiting'),
    );
  });

  it('L-7: stops with a clear message when chunks can no longer be saved, and uploads what was saved', async () => {
    const { user, rec, api } = setup({}, 'granted', 1);
    await toRecord(user);
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Turn on recording' }));
    await user.click(screen.getByLabelText(/i told everyone/i));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByTestId('recording-indicator')).toHaveTextContent('Recording');
    act(() => rec.emit(new Uint8Array([1])));
    act(() => rec.emit(new Uint8Array([2])));
    expect(await screen.findByText(/Recording stopped/)).toBeInTheDocument();
    expect(rec.stopped).toBe(true);
    await waitFor(() => expect(api.complete).toHaveBeenCalled());
    expect(vi.mocked(api.complete).mock.calls[0]![1]).toMatchObject({ chunkCount: 1 });
  });

  it('shows OS guidance when the microphone is blocked', async () => {
    const { user } = setup({}, 'denied');
    await toRecord(user);
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Turn on recording' }));
    await user.click(screen.getByLabelText(/i told everyone/i));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    expect(await screen.findByRole('dialog', { name: 'Microphone is blocked' })).toHaveTextContent(
      /system settings/i,
    );
  });

  it('keeps permanently failed uploads for retry or delete', async () => {
    const { user, rec, queue } = setup({
      init: () => Promise.reject(new AuthError('VALIDATION_FAILED', 'bad')),
    });
    await toRecord(user);
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await user.click(screen.getByRole('button', { name: 'Turn on recording' }));
    await user.click(screen.getByLabelText(/i told everyone/i));
    await user.click(screen.getByRole('button', { name: 'Start recording' }));
    await screen.findByTestId('recording-indicator');
    act(() => rec.emit(new Uint8Array([9])));
    await user.click(screen.getByRole('button', { name: 'Stop and save' }));
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /delete recording of sprint planning/i }));
    await waitFor(() => expect(queue.items()).toHaveLength(0));
  });
});
