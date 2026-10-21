import { describe, expect, it, vi } from 'vitest';
import {
  HEARTBEAT_TIMEOUT_MS,
  checkWatchdog,
  describeStorageEvent,
  handleBackgroundMessage,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { loadState } from '../src/lib/recorder-state.js';
import { memoryKV } from '../src/lib/storage.js';

const popup = { fromSelf: true, fromOffscreen: false };
const offscreen = { fromSelf: true, fromOffscreen: true };
const bg = <T extends object>(m: T) => ({ target: 'background', ...m });

function setup() {
  let t = 1000;
  const deps = {
    kv: memoryKV(),
    now: () => t,
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    sendToOffscreen: vi.fn(async () => ({ ok: true })),
    hasOffscreen: vi.fn(async () => true),
    startWatchdog: vi.fn(async () => undefined),
    stopWatchdog: vi.fn(async () => undefined),
    finalizeAfterCrash: vi.fn(async () => undefined),
    setBadge: vi.fn(async () => undefined),
  } satisfies BackgroundDeps;
  const advance = (ms: number) => (t += ms);
  const startRecording = async () => {
    await handleBackgroundMessage(deps, bg({ type: 'ACK_CONSENT', tabId: 1 }), popup);
    await handleBackgroundMessage(
      deps,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 's' }),
      popup,
    );
    await handleBackgroundMessage(deps, bg({ type: 'REC_STARTED', sessionId: 'u1' }), offscreen);
    await handleBackgroundMessage(deps, bg({ type: 'REC_CHUNK', seq: 0 }), offscreen);
  };
  return { deps, advance, startRecording };
}

describe('offscreen heartbeat watchdog', () => {
  it('starts the watchdog alarm on START and stops it on normal stop', async () => {
    const { deps, startRecording } = setup();
    await startRecording();
    expect(deps.startWatchdog).toHaveBeenCalled();
    await handleBackgroundMessage(deps, bg({ type: 'STOP_RECORDING' }), popup);
    await handleBackgroundMessage(deps, bg({ type: 'REC_STOPPED', chunkCount: 1 }), offscreen);
    expect(deps.stopWatchdog).toHaveBeenCalled();
    expect((await loadState(deps.kv)).status).toBe('idle');
  });

  it('stays healthy while heartbeats arrive', async () => {
    const { deps, advance, startRecording } = setup();
    await startRecording();
    for (let i = 0; i < 5; i++) {
      advance(HEARTBEAT_TIMEOUT_MS - 1000);
      await handleBackgroundMessage(
        deps,
        bg({ type: 'REC_HEARTBEAT', sessionId: 'u1' }),
        offscreen,
      );
      expect((await checkWatchdog(deps)).status).toBe('recording');
    }
  });

  it('moves to error, finalizes the session and badges when heartbeats stop', async () => {
    const { deps, advance, startRecording } = setup();
    await startRecording();
    advance(HEARTBEAT_TIMEOUT_MS + 1);
    const s = await checkWatchdog(deps);
    expect(s.status).toBe('error');
    expect(deps.finalizeAfterCrash).toHaveBeenCalledWith('u1', 1, HEARTBEAT_TIMEOUT_MS + 1);
    expect(deps.setBadge).toHaveBeenCalledWith('!');
    expect(deps.closeOffscreen).toHaveBeenCalled();
    expect(deps.stopWatchdog).toHaveBeenCalled();
  });

  it('detects a missing offscreen document even with a recent heartbeat', async () => {
    const { deps, startRecording } = setup();
    await startRecording();
    deps.hasOffscreen.mockResolvedValue(false);
    const r = await handleBackgroundMessage(deps, bg({ type: 'GET_STATUS' }), popup);
    expect(r).toMatchObject({ ok: true, status: 'error' });
  });

  it('ignores late recorder events after error; STOP dismisses error; can start again', async () => {
    const { deps, advance, startRecording } = setup();
    await startRecording();
    advance(HEARTBEAT_TIMEOUT_MS + 1);
    await checkWatchdog(deps);
    await handleBackgroundMessage(deps, bg({ type: 'REC_STOPPED', chunkCount: 1 }), offscreen);
    expect((await loadState(deps.kv)).status).toBe('error');
    const r = await handleBackgroundMessage(deps, bg({ type: 'STOP_RECORDING' }), popup);
    expect(r).toMatchObject({ ok: true, status: 'idle' });
    expect(deps.setBadge).toHaveBeenLastCalledWith('');
    deps.hasOffscreen.mockResolvedValue(true);
    await startRecording();
    expect((await loadState(deps.kv)).status).toBe('recording');
  });

  it('does nothing when idle', async () => {
    const { deps } = setup();
    expect((await checkWatchdog(deps)).status).toBe('idle');
    expect(deps.setBadge).not.toHaveBeenCalled();
  });
});

describe('storage warnings', () => {
  it('warns without marking incomplete when only uploaded chunks were evicted', async () => {
    const { deps, startRecording } = setup();
    await startRecording();
    const r = await handleBackgroundMessage(
      deps,
      bg({
        type: 'REC_STORAGE',
        event: { kind: 'evicted', count: 2, bytes: 2 * 1024 * 1024, lostPending: 0 },
      }),
      offscreen,
    );
    expect(r).toMatchObject({
      storageWarning: expect.stringContaining('2 already-uploaded chunk(s) (2.0 MB)'),
    });
    expect(r.ok && r.incomplete).toBeFalsy();
    const d = await handleBackgroundMessage(deps, bg({ type: 'DISMISS_WARNING' }), popup);
    expect(d.ok && d.storageWarning).toBeFalsy();
  });

  it('marks the recording incomplete when pending audio is evicted or refused, through stop', async () => {
    const { deps, startRecording } = setup();
    await startRecording();
    const r = await handleBackgroundMessage(
      deps,
      bg({ type: 'REC_STORAGE', event: { kind: 'evicted', count: 1, bytes: 10, lostPending: 1 } }),
      offscreen,
    );
    expect(r).toMatchObject({ incomplete: true });
    expect(describeStorageEvent({ kind: 'refused', seq: 4 })).toContain('will not be submitted');
    await handleBackgroundMessage(deps, bg({ type: 'STOP_RECORDING' }), popup);
    const stopped = await handleBackgroundMessage(
      deps,
      bg({ type: 'REC_STOPPED', chunkCount: 3 }),
      offscreen,
    );
    expect(stopped).toMatchObject({ status: 'idle', incomplete: true });
    const d = await handleBackgroundMessage(deps, bg({ type: 'DISMISS_WARNING' }), popup);
    expect(d.ok && d.incomplete).toBeFalsy();
    // A new recording starts clean.
    await startRecording();
    const s = await handleBackgroundMessage(deps, bg({ type: 'GET_STATUS' }), popup);
    expect(s.ok && s.incomplete).toBeFalsy();
  });

  it('rejects malformed storage events', async () => {
    const { deps } = setup();
    const r = await handleBackgroundMessage(
      deps,
      bg({ type: 'REC_STORAGE', event: { kind: 'evicted' } }),
      offscreen,
    );
    expect(r.ok).toBe(false);
  });
});
