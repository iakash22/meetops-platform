import '@testing-library/react-native/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';

import {
  elapsedMs,
  formatElapsed,
  initialRecorderState,
  recorderReducer,
  spokenElapsed,
} from '../src/record/recorderShell';
import { createDemoConsentApi } from '../src/consent/consentApi';
import { RepositoriesProvider } from '../src/data/RepositoriesProvider';
import { RecordScreen } from '../src/screens/RecordScreen';
import { makeRepositories } from './support/appRoutes';
import { ApiError } from '../src/api/client';
import { sha256Hex } from '../src/record/sha256';
import { createSimulatedCapture } from '../src/record/simulatedRecorder';
import { createMemoryQueueStore, createSimulatedUploadApi } from '../src/upload/simulatedUploadApi';
import type { RecordingUploadApi } from '../src/upload/types';
import { createUploadQueueEngine } from '../src/upload/uploadQueueEngine';

describe('recorder state machine', () => {
  it('follows idle → recording → paused → recording → stopped → idle and keeps time', () => {
    let s = recorderReducer(initialRecorderState, { type: 'start', now: 1_000 });
    expect(s.phase).toBe('recording');
    expect(elapsedMs(s, 4_000)).toBe(3_000);
    s = recorderReducer(s, { type: 'pause', now: 4_000 });
    expect(s.phase).toBe('paused');
    expect(elapsedMs(s, 99_000)).toBe(3_000);
    s = recorderReducer(s, { type: 'resume', now: 10_000 });
    s = recorderReducer(s, { type: 'stop', now: 12_500 });
    expect(s).toEqual({ phase: 'stopped', accumulatedMs: 5_500, startedAt: null });
    expect(recorderReducer(s, { type: 'reset' })).toEqual(initialRecorderState);
  });

  it('ignores invalid transitions', () => {
    expect(recorderReducer(initialRecorderState, { type: 'stop', now: 1 })).toBe(
      initialRecorderState,
    );
    expect(recorderReducer(initialRecorderState, { type: 'pause', now: 1 })).toBe(
      initialRecorderState,
    );
    const rec = recorderReducer(initialRecorderState, { type: 'start', now: 0 });
    expect(recorderReducer(rec, { type: 'start', now: 5 })).toBe(rec);
    expect(recorderReducer(rec, { type: 'reset' })).toBe(rec);
  });

  it('formats elapsed time for display and screen readers', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65_900)).toBe('01:05');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(spokenElapsed(1_000)).toBe('1 second');
    expect(spokenElapsed(65_000)).toBe('1 minute 5 seconds');
    expect(spokenElapsed(3_600_000)).toBe('1 hour 0 minutes 0 seconds');
  });
});

describe('Record tab UI', () => {
  let loop: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-25T10:00:00Z') });
    loop = jest
      .spyOn(Animated, 'loop')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function renderRecord(
    reducedMotion = false,
    repos = makeRepositories({ consent: createDemoConsentApi({ optedIn: true }) }),
  ) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reducedMotion);
    render(
      <RepositoriesProvider value={repos}>
        <RecordScreen />
      </RepositoriesProvider>,
    );
    await act(async () => {});
  }

  /** Start passes the per-recording participant notice (opt-in already given). */
  async function startRecording() {
    fireEvent.press(screen.getByTestId('record-button'));
    await act(async () => {});
    fireEvent.press(screen.getByTestId('consent-notice-accept'));
    await act(async () => {});
  }

  const advance = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  it('starts idle with a preview-only notice and an empty upload queue', async () => {
    await renderRecord();
    expect(screen.getByTestId('record-preview-notice')).toHaveTextContent(
      /Nothing is recorded, saved or uploaded/,
    );
    expect(screen.getByTestId('record-button')).toHaveProp('accessibilityLabel', 'Start recording');
    expect(screen.getByTestId('record-button')).toHaveProp(
      'accessibilityHint',
      'Preview only, no audio is captured',
    );
    expect(screen.getByTestId('record-timer')).toHaveTextContent('00:00');
    expect(screen.getByTestId('record-status')).toHaveTextContent('Ready');
    expect(screen.getByTestId('upload-queue-status')).toHaveTextContent(
      'Nothing waiting to upload.',
    );
    expect(screen.queryByTestId('record-pause')).toBeNull();
  });

  it('runs the timer while recording, pauses, resumes and stops without saving', async () => {
    await renderRecord();
    await startRecording();
    expect(screen.getByTestId('record-status')).toHaveTextContent('Recording');
    expect(screen.getByTestId('record-button')).toHaveProp('accessibilityLabel', 'Stop recording');
    expect(screen.getAllByTestId('record-live-dot', { includeHiddenElements: true })).toHaveLength(
      1,
    );

    advance(65_000);
    expect(screen.getByTestId('record-timer')).toHaveTextContent('01:05');
    expect(screen.getByTestId('record-timer')).toHaveProp(
      'accessibilityLabel',
      'Elapsed time 1 minute 5 seconds',
    );

    fireEvent.press(screen.getByTestId('record-pause'));
    expect(screen.getByTestId('record-status')).toHaveTextContent('Paused');
    advance(30_000);
    expect(screen.getByTestId('record-timer')).toHaveTextContent('01:05');

    fireEvent.press(screen.getByTestId('record-pause')); // Resume
    advance(5_000);
    expect(screen.getByTestId('record-timer')).toHaveTextContent('01:10');

    fireEvent.press(screen.getByTestId('record-button'));
    expect(screen.getByTestId('record-status')).toHaveTextContent('Stopped');
    expect(screen.getByTestId('record-summary')).toHaveTextContent(
      'Preview ended at 01:10. Nothing was saved.',
    );
    expect(screen.queryByTestId('record-button')).toBeNull();

    fireEvent.press(screen.getByTestId('record-done'));
    expect(screen.getByTestId('record-timer')).toHaveTextContent('00:00');
    expect(screen.getByTestId('record-button')).toHaveProp('accessibilityLabel', 'Start recording');
  });

  it('pulses the halo while recording when motion is allowed', async () => {
    await renderRecord(false);
    expect(loop).not.toHaveBeenCalled();
    await startRecording();
    expect(loop).toHaveBeenCalled();
  });

  it('keeps the halo still when reduce motion is on', async () => {
    await renderRecord(true);
    await startRecording();
    advance(2_000);
    expect(loop).not.toHaveBeenCalled();
    expect(screen.getByTestId('record-timer')).toHaveTextContent('00:02');
  });

  it('shows queued and offline states from the upload queue', async () => {
    await renderRecord(
      false,
      makeRepositories({
        uploadQueue: { status: () => Promise.resolve({ pending: 2, offline: true }) },
      }),
    );
    expect(screen.getByTestId('upload-queue-status')).toHaveTextContent(
      "Offline. 2 recordings waiting to upload. Uploads resume when you're back online.",
    );
  });
});

describe('Record tab with the simulated recorder', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-25T10:00:00Z') });
    jest
      .spyOn(Animated, 'loop')
      .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function setup(api: Partial<RecordingUploadApi> = {}) {
    const capture = createSimulatedCapture();
    const engine = createUploadQueueEngine({
      store: createMemoryQueueStore(),
      chunks: capture,
      api: { ...createSimulatedUploadApi(0), ...api },
      network: { isOnline: () => true },
    });
    const repos = makeRepositories({
      consent: createDemoConsentApi({ optedIn: true }),
      uploadQueue: engine,
      recordings: { engine, capture, organizationId: () => 'org-1' },
    });
    render(
      <RepositoriesProvider value={repos}>
        <RecordScreen />
      </RepositoriesProvider>,
    );
    return { engine, capture };
  }

  async function recordFor(ms: number) {
    await act(async () => {});
    fireEvent.press(screen.getByTestId('record-button'));
    await act(async () => {});
    fireEvent.press(screen.getByTestId('consent-notice-accept'));
    await act(async () => {});
    act(() => {
      jest.advanceTimersByTime(ms);
    });
    fireEvent.press(screen.getByTestId('record-button'));
    await act(async () => {
      await jest.runAllTimersAsync();
    });
  }

  it('labels the simulated recorder clearly', async () => {
    setup();
    await act(async () => {});
    expect(screen.getByTestId('record-simulated-notice')).toHaveTextContent(
      /No audio is captured.*Uploads are simulated/,
    );
  });

  it('queues the recording on stop with its consent and uploads it', async () => {
    const init = jest.fn(() => Promise.resolve({ sessionId: 's-1' }));
    const remove = jest.fn();
    const { capture, engine } = setup({ init });
    const realRemove = capture.remove.bind(capture);
    capture.remove = (id) => {
      remove(id);
      return realRemove(id);
    };
    await recordFor(25_000);
    expect(screen.getByTestId('record-summary')).toHaveTextContent(
      "Simulated recording saved at 00:25. It's in the upload queue.",
    );
    expect(init).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        source: 'mobile',
        consent: expect.objectContaining({ method: 'all_parties_notified' }),
      }),
    );
    expect(screen.getByTestId('upload-queue-status')).toHaveTextContent(/Nothing waiting/);
    expect(screen.queryByTestId('upload-queue-items')).toBeNull();
    await expect(engine.items()).resolves.toHaveLength(0);
    // Verified local delete after upload (R6).
    const id = remove.mock.calls[0]?.[0] as string;
    expect(id).toMatch(/^rec-/);
    await expect(capture.exists(id)).resolves.toBe(false);
  });

  it('keeps a rejected upload for retry or delete', async () => {
    const { engine } = setup({
      init: () => Promise.reject(new ApiError(422, 'VALIDATION_FAILED', 'bad')),
    });
    await recordFor(5_000);
    const [item] = await engine.items();
    expect(item?.state).toBe('failed');
    expect(screen.getByTestId(`queue-retry-${item!.id}`)).toBeTruthy();
    expect(screen.getByTestId('upload-queue-status')).toHaveTextContent(/1 needs attention\./);
    fireEvent.press(screen.getByTestId(`queue-delete-${item!.id}`));
    await act(async () => {});
    await expect(engine.items()).resolves.toHaveLength(0);
    expect(screen.queryByTestId('upload-queue-items')).toBeNull();
  });
});

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
