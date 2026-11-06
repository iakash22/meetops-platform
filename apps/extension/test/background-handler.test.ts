import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HELD_CHECK_FAILED_MESSAGE,
  handleBackgroundMessage,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { HELD_FULL_START_MESSAGE, heldStorageLevel } from '../src/lib/drain.js';
import { loadState } from '../src/lib/recorder-state.js';
import { memoryKV } from '../src/lib/storage.js';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import { CONSENT } from './helpers/consent.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const GRANT = { meetingId: MID, method: 'all_parties_consented' as const };

const popup = { fromSelf: true, fromOffscreen: false, fromPopup: true };
const offscreen = { fromSelf: true, fromOffscreen: true, fromPopup: false };
const bg = <T extends object>(m: T) => ({ target: 'background', ...m });

export function makeDeps(kv = memoryKV()) {
  let t = 1000;
  const deps = {
    kv,
    now: () => t,
    ensureOffscreen: vi.fn(async () => undefined),
    closeOffscreen: vi.fn(async () => undefined),
    sendToOffscreen: vi.fn<(m: { type: string }) => Promise<{ ok: boolean }>>(async () => ({
      ok: true,
    })),
    hasOffscreen: vi.fn(async () => true),
    startWatchdog: vi.fn(async () => undefined),
    stopWatchdog: vi.fn(async () => undefined),
    finalizeAfterCrash: vi.fn(async () => undefined),
    capturedTabIds: vi.fn(async (): Promise<number[]> => [1, 2, 3, 7, 9]),
    setBadge: vi.fn(async () => undefined),
    durableKV: memoryKV(),
    discardLocal: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    checkPairing: vi.fn(async () => true),
    storageQuota: vi.fn(async () => ({ usage: 0, quota: 10 * 1024 * 1024 * 1024 })),
    pendingStorage: vi.fn(async () => ({ pendingBytes: 0, capBytes: 500 * 1024 * 1024 })),
    heldRecordings: vi.fn(async () => ({ count: 0, closed: 0 })),
  } satisfies BackgroundDeps;
  return { deps, advance: (ms: number) => (t += ms) };
}

describe('background handler', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it('rejects messages from other extensions/pages', async () => {
    const r = await handleBackgroundMessage(ctx.deps, bg({ type: 'GET_STATUS' }), {
      fromSelf: false,
      fromOffscreen: false,
      fromPopup: false,
    });
    expect(r).toEqual({ ok: false, error: 'Untrusted sender' });
  });

  it('refuses to start without background-recorded consent', async () => {
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId: 's' }),
      popup,
    );
    expect(r.ok).toBe(false);
    expect(ctx.deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses consent given for a different tab', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 2, streamId: 's' }),
      popup,
    );
    expect(r.ok).toBe(false);
  });

  it('refuses expired consent', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    ctx.advance(10 * 60 * 1000);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 's' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: 'Consent expired; acknowledge again' });
  });

  it('consent is per meeting: a confirmation for one meeting cannot start another', async () => {
    const OTHER = '0b4e7f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: OTHER, tabId: 1, streamId: 's' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: 'Consent was given for a different meeting' });
    expect(ctx.deps.ensureOffscreen).not.toHaveBeenCalled();
    // One-shot: the mismatched attempt consumed it, so the original meeting needs a fresh confirmation too.
    const again = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 's2' }),
      popup,
    );
    expect(again.ok).toBe(false);
  });

  it('sends the method the user confirmed and the time they confirmed, not the start time', async () => {
    await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'ACK_CONSENT', tabId: 1, meetingId: MID, method: 'all_parties_notified' }),
      popup,
    );
    ctx.advance(30_000);
    await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'm' }),
      popup,
    );
    expect(ctx.deps.sendToOffscreen).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'OFFSCREEN_START',
        startedAt: 31_000,
        consent: {
          consentVersion: CURRENT_CONSENT_VERSION,
          attestedAt: new Date(1000).toISOString(),
          method: 'all_parties_notified',
        },
      }),
    );
  });

  it('rejects ACK_CONSENT without a meeting or with an unknown method', async () => {
    for (const m of [
      { type: 'ACK_CONSENT', tabId: 1 },
      { type: 'ACK_CONSENT', tabId: 1, meetingId: MID },
      { type: 'ACK_CONSENT', tabId: 1, meetingId: 'meeting-1', method: 'all_parties_consented' },
      { type: 'ACK_CONSENT', tabId: 1, meetingId: MID, method: 'implied' },
    ]) {
      const r = await handleBackgroundMessage(ctx.deps, bg(m), popup);
      expect(r.ok).toBe(false);
    }
    const start = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 's' }),
      popup,
    );
    expect(start.ok).toBe(false);
  });

  it('runs the full lifecycle and persists state in session storage', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const s = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'sid' }),
      popup,
    );
    expect(s).toMatchObject({ ok: true, status: 'starting', tabId: 1 });
    expect(ctx.deps.sendToOffscreen).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      meetingId: MID,
      streamId: 'sid',
      startedAt: 1000,
      consent: {
        consentVersion: CURRENT_CONSENT_VERSION,
        attestedAt: new Date(1000).toISOString(),
        method: 'all_parties_consented',
      },
    });

    await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'REC_STARTED', sessionId: 'u1' }),
      offscreen,
    );
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_CHUNK', seq: 0 }), offscreen);
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_CHUNK', seq: 1 }), offscreen);

    // Simulate service-worker restart: a fresh deps object over the same storage.
    const revived = makeDeps(ctx.deps.kv).deps;
    expect(await handleBackgroundMessage(revived, bg({ type: 'GET_STATUS' }), popup)).toMatchObject(
      {
        status: 'recording',
        chunks: 2,
        startedAt: 1000,
      },
    );

    // A second start is refused while recording.
    await handleBackgroundMessage(revived, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    expect(
      (
        await handleBackgroundMessage(
          revived,
          bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'x' }),
          popup,
        )
      ).ok,
    ).toBe(false);

    expect(
      await handleBackgroundMessage(revived, bg({ type: 'STOP_RECORDING' }), popup),
    ).toMatchObject({ status: 'stopping' });
    await handleBackgroundMessage(revived, bg({ type: 'REC_STOPPED', chunkCount: 2 }), offscreen);
    expect(await loadState(ctx.deps.kv)).toEqual({ status: 'idle' });
    expect(revived.closeOffscreen).toHaveBeenCalled();
  });

  it('only accepts recorder events from the offscreen doc, and commands not from it', async () => {
    expect(
      (await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_STOPPED', chunkCount: 0 }), popup))
        .ok,
    ).toBe(false);
    expect(
      (
        await handleBackgroundMessage(
          ctx.deps,
          bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }),
          offscreen,
        )
      ).ok,
    ).toBe(false);
  });

  it('resets to idle with an error if the offscreen doc fails to start', async () => {
    ctx.deps.sendToOffscreen.mockRejectedValueOnce(new Error('Permission dismissed'));
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 's' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: 'Permission dismissed' });
    expect(await loadState(ctx.deps.kv)).toEqual({
      status: 'idle',
      lastError: 'Permission dismissed',
    });
  });

  it('works with chrome.storage.session via a mocked chrome global', async () => {
    const store: Record<string, unknown> = {};
    const area = {
      get: vi.fn(async (k: string) => (k in store ? { [k]: store[k] } : {})),
      set: vi.fn(async (o: Record<string, unknown>) => void Object.assign(store, o)),
      remove: vi.fn(async (k: string) => void delete store[k]),
    };
    vi.stubGlobal('chrome', { storage: { session: area } });
    const { sessionKV } = await import('../src/lib/storage');
    const c = makeDeps(sessionKV() as ReturnType<typeof memoryKV>);
    await handleBackgroundMessage(c.deps, bg({ type: 'ACK_CONSENT', tabId: 9, ...GRANT }), popup);
    expect(area.set).toHaveBeenCalledWith({
      'consent:9': {
        tabId: 9,
        meetingId: MID,
        method: 'all_parties_consented',
        acknowledgedAt: 1000,
        expiresAt: 121000,
      },
    });
    vi.unstubAllGlobals();
  });
});

describe('security review fixes', () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });
  const start = (tabId: number, streamId: string) =>
    handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId, streamId }),
      popup,
    );

  it('rejects commands from extension pages other than the popup', async () => {
    const otherPage = { fromSelf: true, fromOffscreen: false, fromPopup: false };
    for (const m of [
      { type: 'GET_STATUS' },
      { type: 'ACK_CONSENT', tabId: 1, ...GRANT },
      { type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 's' },
      { type: 'STOP_RECORDING' },
    ]) {
      const r = await handleBackgroundMessage(ctx.deps, bg(m), otherPage);
      expect(r).toEqual({ ok: false, error: 'Commands must come from the popup' });
    }
    expect(ctx.deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('consumes consent atomically: two concurrent starts, one acknowledgement, one wins', async () => {
    const { consumeConsent, recordConsent } = await import('../src/lib/consent-registry.js');
    await recordConsent(ctx.deps.kv, 1, 1000, GRANT);
    const rs = await Promise.all([
      consumeConsent(ctx.deps.kv, 1, 1000, MID),
      consumeConsent(ctx.deps.kv, 1, 1000, MID),
      consumeConsent(ctx.deps.kv, 1, 1000, MID),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it('serialized() runs handlers one at a time', async () => {
    const { serialized } = await import('../src/lib/background-handler.js');
    const h = serialized(handleBackgroundMessage);
    await h(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const rs = await Promise.all([
      h(ctx.deps, bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'a' }), popup),
      h(ctx.deps, bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'b' }), popup),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(ctx.deps.ensureOffscreen).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused streamId', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    expect((await start(1, 'sid')).ok).toBe(true);
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_STOPPED', chunkCount: 0 }), offscreen);
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    expect(await start(1, 'sid')).toEqual({ ok: false, error: 'Stream id already used' });
  });

  it('stops when Chrome reports a different captured tab than the consented one', async () => {
    ctx.deps.capturedTabIds.mockResolvedValue([2]);
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    await start(1, 'sid');
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'REC_STARTED', sessionId: 'u1' }),
      offscreen,
    );
    expect(r).toMatchObject({ ok: true, status: 'idle' });
    expect(ctx.deps.sendToOffscreen).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'OFFSCREEN_DISCARD',
    });
    expect(ctx.deps.setBadge).toHaveBeenLastCalledWith('!');
    expect((await loadState(ctx.deps.kv)).status).toBe('idle');
  });

  it('shows REC while recording, clears on stop, ! on error', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    await start(1, 's1');
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_STARTED', sessionId: 'u' }), offscreen);
    expect(ctx.deps.setBadge).toHaveBeenLastCalledWith('REC');
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_STOPPED', chunkCount: 0 }), offscreen);
    expect(ctx.deps.setBadge).toHaveBeenLastCalledWith('');
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    await start(1, 's2');
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_STARTED', sessionId: 'u' }), offscreen);
    await handleBackgroundMessage(ctx.deps, bg({ type: 'REC_ERROR', error: 'x' }), offscreen);
    expect(ctx.deps.setBadge).toHaveBeenLastCalledWith('!');
  });
});

describe('meetingId (contracts v0.2 @ a9d9d89)', () => {
  it('threads meetingId from START_RECORDING to OFFSCREEN_START and rejects non-UUIDs', async () => {
    const { deps } = makeDeps();
    await handleBackgroundMessage(deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const bad = await handleBackgroundMessage(
      deps,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 'x', meetingId: 'meeting-1' }),
      popup,
    );
    expect(bad).toEqual({ ok: false, error: 'Unknown or malformed message' });
    const ok = await handleBackgroundMessage(
      deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'y' }),
      popup,
    );
    expect(ok.ok).toBe(true);
    expect(deps.sendToOffscreen).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_START', meetingId: MID, streamId: 'y' }),
    );
    expect(await loadState(deps.kv)).toMatchObject({ meetingId: MID });
  });
});

describe('offscreen timeout', () => {
  it('fails closed when the held-recordings check throws: nothing starts', async () => {
    const ctx = makeDeps();
    const d = { ...ctx.deps, heldRecordings: vi.fn(async () => Promise.reject(new Error('idb'))) };
    await handleBackgroundMessage(d, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const r = await handleBackgroundMessage(
      d,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'held-err' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: HELD_CHECK_FAILED_MESSAGE });
    expect(d.ensureOffscreen).not.toHaveBeenCalled();
    expect((await loadState(d.kv)).status).toBe('idle');
  });

  it('fails closed when saving the starting state throws: no offscreen, state stays idle', async () => {
    const ctx = makeDeps();
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const realSet = ctx.deps.kv.set.bind(ctx.deps.kv);
    const spy = vi.spyOn(ctx.deps.kv, 'set').mockRejectedValueOnce(new Error('quota'));
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'save-err' }),
      popup,
    );
    spy.mockImplementation(realSet);
    expect(r).toEqual({ ok: false, error: 'quota' });
    expect(ctx.deps.ensureOffscreen).not.toHaveBeenCalled();
    expect((await loadState(ctx.deps.kv)).status).toBe('idle');
  });

  it('on a failed OFFSCREEN_START, discards anything the offscreen doc started and closes it', async () => {
    const ctx = makeDeps();
    ctx.deps.sendToOffscreen.mockRejectedValueOnce(new Error('boom'));
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 1, streamId: 'start-err' }),
      popup,
    );
    const types = ctx.deps.sendToOffscreen.mock.calls.map(([m]) => m.type);
    expect(types).toEqual(['OFFSCREEN_START', 'OFFSCREEN_DISCARD']);
    expect(ctx.deps.closeOffscreen).toHaveBeenCalled();
    expect(ctx.deps.stopWatchdog).toHaveBeenCalled();
  });

  it('discards a late REC_STARTED that arrives after Start already failed', async () => {
    const ctx = makeDeps();
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'REC_STARTED', sessionId: '33333333-3333-4333-8333-333333333333' }),
      offscreen,
    );
    expect(r).toMatchObject({ ok: true, status: 'idle' });
    expect(ctx.deps.sendToOffscreen).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_DISCARD' }),
    );
    expect(ctx.deps.closeOffscreen).toHaveBeenCalled();
    expect(ctx.deps.setBadge).not.toHaveBeenCalledWith('REC');
  });

  it('a hung OFFSCREEN_START times out, goes to error, closes offscreen and frees the lock', async () => {
    const { serialized } = await import('../src/lib/background-handler.js');
    const { deps } = makeDeps();
    deps.sendToOffscreen.mockImplementation(() => new Promise(() => undefined));
    const d = { ...deps, offscreenTimeoutMs: 20 };
    const h = serialized(handleBackgroundMessage);
    await h(d, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    const r = await h(
      d,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 'hang', meetingId: MID }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: 'Offscreen recorder did not respond within 0.02s' });
    expect(deps.closeOffscreen).toHaveBeenCalled();
    expect(deps.setBadge).toHaveBeenLastCalledWith('!');
    expect(await h(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      ok: true,
      status: 'idle',
      lastError: expect.stringContaining('did not respond'),
    });
  });
});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

describe('pending discard marker (captured-tab mismatch)', () => {
  const mismatch = async (ctx: ReturnType<typeof makeDeps>) => {
    ctx.deps.capturedTabIds.mockResolvedValue([2]);
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: crypto.randomUUID(), meetingId: MID }),
      popup,
    );
    return handleBackgroundMessage(ctx.deps, bg({ type: 'REC_STARTED', sessionId: S1 }), offscreen);
  };

  it('records the marker before discarding and clears it when the offscreen discard succeeds', async () => {
    const ctx = makeDeps();
    let markerDuringDiscard: unknown;
    ctx.deps.sendToOffscreen.mockImplementation(async () => {
      markerDuringDiscard = await ctx.deps.durableKV.get('pendingDiscards');
      return { ok: true };
    });
    await mismatch(ctx);
    expect(markerDuringDiscard).toEqual([{ sessionId: S1, attempts: 0 }]);
    expect(await ctx.deps.durableKV.get('pendingDiscards')).toBeUndefined();
    expect(ctx.deps.discardLocal).not.toHaveBeenCalled();
  });

  it('on offscreen timeout, closes offscreen then deletes locally and clears the marker', async () => {
    const ctx = makeDeps();
    ctx.deps.sendToOffscreen.mockImplementation(() => new Promise(() => undefined));
    const d = { ...ctx.deps, offscreenTimeoutMs: 10 };
    const order: string[] = [];
    ctx.deps.closeOffscreen.mockImplementation(async () => void order.push('close'));
    ctx.deps.discardLocal.mockImplementation(
      async (id: string) => void order.push(`discard:${id}`),
    );
    ctx.deps.capturedTabIds.mockResolvedValue([2]);
    await handleBackgroundMessage(d, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    // START also goes through sendToOffscreen; let it succeed once, then hang on DISCARD.
    ctx.deps.sendToOffscreen.mockResolvedValueOnce({ ok: true });
    await handleBackgroundMessage(
      d,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 'x1', meetingId: MID }),
      popup,
    );
    const r = await handleBackgroundMessage(
      d,
      bg({ type: 'REC_STARTED', sessionId: S2 }),
      offscreen,
    );
    expect(r).toMatchObject({ ok: true, status: 'idle' });
    expect(order).toEqual(['close', `discard:${S2}`]);
    expect(await ctx.deps.durableKV.get('pendingDiscards')).toBeUndefined();
  });

  it('keeps the marker when local cleanup also fails, for retry on the next worker start', async () => {
    const ctx = makeDeps();
    ctx.deps.sendToOffscreen.mockImplementation(async (m: { type: string }) => {
      if (m.type === 'OFFSCREEN_DISCARD') throw new Error('gone');
      return { ok: true };
    });
    ctx.deps.discardLocal.mockRejectedValue(new Error('idb blocked'));
    await mismatch(ctx);
    expect(await ctx.deps.durableKV.get('pendingDiscards')).toEqual([
      { sessionId: S1, attempts: 1 },
    ]);
  });
});

describe('discard that keeps failing (handler)', () => {
  it('after the cap and a failed fallback, shows the ! badge and a popup message', async () => {
    const { DISCARD_FAILED_MESSAGE, MAX_DISCARD_ATTEMPTS } =
      await import('../src/lib/pending-discard.js');
    const ctx = makeDeps();
    await ctx.deps.durableKV.set('pendingDiscards', [
      { sessionId: S1, attempts: MAX_DISCARD_ATTEMPTS - 1 },
    ]);
    ctx.deps.sendToOffscreen.mockImplementation(async (m: { type: string }) => {
      if (m.type === 'OFFSCREEN_DISCARD') throw new Error('gone');
      return { ok: true };
    });
    ctx.deps.discardLocal.mockRejectedValue(new Error('idb blocked'));
    const deleteLocal = vi.fn(async () => Promise.reject(new Error('still blocked')));
    const d = { ...ctx.deps, deleteLocal };
    ctx.deps.capturedTabIds.mockResolvedValue([2]);
    await handleBackgroundMessage(d, bg({ type: 'ACK_CONSENT', tabId: 1, ...GRANT }), popup);
    await handleBackgroundMessage(
      d,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 'x9', meetingId: MID }),
      popup,
    );
    await handleBackgroundMessage(d, bg({ type: 'REC_STARTED', sessionId: S1 }), offscreen);
    expect(deleteLocal).toHaveBeenCalledWith(S1);
    expect(ctx.deps.setBadge).toHaveBeenLastCalledWith('!');
    expect(await ctx.deps.durableKV.get('pendingDiscards')).toEqual([
      { sessionId: S1, attempts: MAX_DISCARD_ATTEMPTS, failed: true },
    ]);
    expect(await handleBackgroundMessage(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      status: 'idle',
      lastError: expect.stringContaining(DISCARD_FAILED_MESSAGE),
    });
  });
});

describe('retryPendingDiscards (worker start)', () => {
  it('deletes each pending session and clears only the ones that succeed', async () => {
    const { addPendingDiscard, retryPendingDiscards, listPendingDiscards } =
      await import('../src/lib/pending-discard.js');
    const kv = memoryKV();
    await addPendingDiscard(kv, S1);
    await addPendingDiscard(kv, S2);
    await addPendingDiscard(kv, S1);
    const discard = vi.fn(async (id: string) => {
      if (id === S2) throw new Error('fail');
    });
    expect(await retryPendingDiscards(kv, discard)).toEqual([S2]);
    expect(discard).toHaveBeenCalledTimes(2);
    discard.mockResolvedValue(undefined);
    expect(await retryPendingDiscards(kv, discard)).toEqual([]);
    expect(await listPendingDiscards(kv)).toEqual([]);
  });

  it('with a real ChunkStore: removes the session and its chunks and aborts consent_revoked', async () => {
    const { ChunkStore } = await import('../src/lib/chunk-store.js');
    const { StubUploadClient } = await import('../src/lib/upload.js');
    const { addPendingDiscard, retryPendingDiscards } =
      await import('../src/lib/pending-discard.js');
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, new IDBFactory());
    const client = new StubUploadClient();
    const { sessionId } = await client.initSession({
      mimeType: 'audio/webm;codecs=opus',
      startedAt: new Date(0).toISOString(),
      source: 'tab',
      consent: CONSENT,
      meetingId: MID,
    });
    await store.putSession({
      sessionId,
      meta: {
        mimeType: 'audio/webm',
        startedAt: new Date(0).toISOString(),
        source: 'tab',
        consent: CONSENT,
        meetingId: MID,
      },
      completed: false,
    });
    await store.putChunk({
      sessionId,
      seq: 0,
      data: new ArrayBuffer(3),
      mimeType: 'audio/webm',
      createdAt: 0,
    });
    const kv = memoryKV();
    await addPendingDiscard(kv, sessionId);
    const left = await retryPendingDiscards(kv, async (id) => {
      await store.deleteSession(id);
      await client.abort(id, { reason: 'consent_revoked' });
    });
    expect(left).toEqual([]);
    expect(await store.getSession(sessionId)).toBeUndefined();
    expect(await store.listChunks(sessionId)).toHaveLength(0);
    expect(client.sessions.get(sessionId)!.aborted).toBe('consent_revoked');
  });
});

describe('held recordings (409/413 refusals kept locally)', () => {
  function heldDeps(initial: { count: number; closed: number }) {
    const h = { ...initial };
    const { deps } = makeDeps();
    const retryHeld = vi.fn(async () => {
      h.count = h.closed; // retryable ones complete; closed ones stay until discarded
    });
    const discardHeld = vi.fn(async () => {
      h.count = 0;
      h.closed = 0;
    });
    return { d: { ...deps, heldRecordings: async () => ({ ...h }), retryHeld, discardHeld }, h };
  }

  it('GET_STATUS reports held recordings and RETRY_HELD_UPLOADS retries them from the popup only', async () => {
    const { d } = heldDeps({ count: 1, closed: 0 });
    expect(await handleBackgroundMessage(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      ok: true,
      heldRecordings: 1,
    });
    expect(d.setBadge).toHaveBeenLastCalledWith('!');
    expect(
      (await handleBackgroundMessage(d, bg({ type: 'RETRY_HELD_UPLOADS' }), offscreen)).ok,
    ).toBe(false);
    expect(d.retryHeld).not.toHaveBeenCalled();
    const r = await handleBackgroundMessage(d, bg({ type: 'RETRY_HELD_UPLOADS' }), popup);
    expect(d.retryHeld).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true });
    expect(r).not.toHaveProperty('heldRecordings');
    expect(d.setBadge).toHaveBeenLastCalledWith(''); // badge clears once nothing is held
  });

  it('server-closed sessions (consent_revoked) are reported as terminal and only discard removes them', async () => {
    const { d } = heldDeps({ count: 1, closed: 1 });
    expect(await handleBackgroundMessage(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      heldRecordings: 1,
      heldClosed: 1,
    });
    await handleBackgroundMessage(d, bg({ type: 'RETRY_HELD_UPLOADS' }), popup);
    expect(await handleBackgroundMessage(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      heldClosed: 1,
    });
    const r = await handleBackgroundMessage(
      d,
      bg({ type: 'DISCARD_HELD_UPLOADS', confirmed: true }),
      popup,
    );
    expect(d.discardHeld).toHaveBeenCalledTimes(1);
    expect(r).not.toHaveProperty('heldRecordings');
    expect(d.setBadge).toHaveBeenLastCalledWith('');
  });

  it('DISCARD_HELD_UPLOADS requires the confirmation flag and the popup sender', async () => {
    const { d } = heldDeps({ count: 2, closed: 0 });
    for (const m of [
      bg({ type: 'DISCARD_HELD_UPLOADS' }),
      bg({ type: 'DISCARD_HELD_UPLOADS', confirmed: false }),
      bg({ type: 'DISCARD_HELD_UPLOADS', confirmed: 'yes' }),
    ])
      expect((await handleBackgroundMessage(d, m, popup)).ok).toBe(false);
    expect(
      (
        await handleBackgroundMessage(
          d,
          bg({ type: 'DISCARD_HELD_UPLOADS', confirmed: true }),
          offscreen,
        )
      ).ok,
    ).toBe(false);
    expect(d.discardHeld).not.toHaveBeenCalled();
  });

  it('flags storage full while recordings are held; the badge stays for other alerts', async () => {
    const { d } = heldDeps({ count: 1, closed: 0 });
    await handleBackgroundMessage(
      d,
      bg({ type: 'REC_STORAGE', event: { kind: 'refused', seq: 3 } }),
      offscreen,
    );
    expect(await handleBackgroundMessage(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      heldRecordings: 1,
      heldStorageFull: true,
    });
  });
});

describe('held recordings vs new recordings (#307 L-1)', () => {
  const MB = 1024 * 1024;
  const cap = 100 * MB;
  function depsWith(bytes: number) {
    const { deps } = makeDeps();
    return {
      ...deps,
      heldRecordings: async () => ({ count: 1, closed: 0, bytes, capBytes: cap }),
      retryHeld: vi.fn(async () => undefined),
      discardHeld: vi.fn(async () => undefined),
    };
  }

  it('classifies held usage: ok below 80%, near-full at 80%, full when too little room is left', () => {
    expect(heldStorageLevel({ bytes: 79 * MB, capBytes: cap })).toBe('ok');
    expect(heldStorageLevel({ bytes: 80 * MB, capBytes: cap })).toBe('near-full');
    expect(heldStorageLevel({ bytes: 96 * MB, capBytes: cap })).toBe('full');
    expect(heldStorageLevel({ bytes: cap, capBytes: cap })).toBe('full');
    expect(heldStorageLevel({ bytes: 0, capBytes: cap })).toBe('ok');
  });

  it('GET_STATUS warns before recording when held bytes reach the threshold', async () => {
    const r = await handleBackgroundMessage(depsWith(85 * MB), bg({ type: 'GET_STATUS' }), popup);
    expect(r).toMatchObject({ heldNearFull: true });
    expect(r).not.toHaveProperty('heldBlocksStart');
  });

  it('held data alone fills the cap: Start is refused and the storage-full message is shown', async () => {
    const d = depsWith(cap);
    expect(await handleBackgroundMessage(d, bg({ type: 'GET_STATUS' }), popup)).toMatchObject({
      heldBlocksStart: true,
      heldStorageFull: true,
    });
    await handleBackgroundMessage(d, bg({ type: 'ACK_CONSENT', tabId: 3, ...GRANT }), popup);
    const r = await handleBackgroundMessage(
      d,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId: 's-full' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: HELD_FULL_START_MESSAGE });
    expect(d.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('near-full does not block Start', async () => {
    const d = depsWith(85 * MB);
    await handleBackgroundMessage(d, bg({ type: 'ACK_CONSENT', tabId: 3, ...GRANT }), popup);
    const r = await handleBackgroundMessage(
      d,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId: 's-near' }),
      popup,
    );
    expect(r.ok).toBe(true);
  });
});
