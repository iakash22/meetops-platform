import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBackgroundMessage, type BackgroundDeps } from '../src/lib/background-handler.js';
import { loadState } from '../src/lib/recorder-state.js';
import { memoryKV } from '../src/lib/storage.js';

const popup = { fromSelf: true, fromOffscreen: false };
const offscreen = { fromSelf: true, fromOffscreen: true };
const bg = <T extends object>(m: T) => ({ target: 'background', ...m });

export function makeDeps(kv = memoryKV()) {
  let t = 1000;
  const deps = {
    kv,
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
    });
    expect(r).toEqual({ ok: false, error: 'Untrusted sender' });
  });

  it('refuses to start without background-recorded consent', async () => {
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', tabId: 3, streamId: 's' }),
      popup,
    );
    expect(r.ok).toBe(false);
    expect(ctx.deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses consent given for a different tab', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1 }), popup);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', tabId: 2, streamId: 's' }),
      popup,
    );
    expect(r.ok).toBe(false);
  });

  it('refuses expired consent', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1 }), popup);
    ctx.advance(10 * 60 * 1000);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 's' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: 'Consent expired; acknowledge again' });
  });

  it('runs the full lifecycle and persists state in session storage', async () => {
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1 }), popup);
    const s = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 'sid' }),
      popup,
    );
    expect(s).toMatchObject({ ok: true, status: 'starting', tabId: 1 });
    expect(ctx.deps.sendToOffscreen).toHaveBeenCalledWith({
      target: 'offscreen',
      type: 'OFFSCREEN_START',
      streamId: 'sid',
      startedAt: 1000,
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
    await handleBackgroundMessage(revived, bg({ type: 'ACK_CONSENT', tabId: 1 }), popup);
    expect(
      (
        await handleBackgroundMessage(
          revived,
          bg({ type: 'START_RECORDING', tabId: 1, streamId: 'x' }),
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
      (await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1 }), offscreen))
        .ok,
    ).toBe(false);
  });

  it('resets to idle with an error if the offscreen doc fails to start', async () => {
    ctx.deps.sendToOffscreen.mockRejectedValueOnce(new Error('Permission dismissed'));
    await handleBackgroundMessage(ctx.deps, bg({ type: 'ACK_CONSENT', tabId: 1 }), popup);
    const r = await handleBackgroundMessage(
      ctx.deps,
      bg({ type: 'START_RECORDING', tabId: 1, streamId: 's' }),
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
    await handleBackgroundMessage(c.deps, bg({ type: 'ACK_CONSENT', tabId: 9 }), popup);
    expect(area.set).toHaveBeenCalledWith({
      'consent:9': { tabId: 9, acknowledgedAt: 1000, expiresAt: 121000 },
    });
    vi.unstubAllGlobals();
  });
});
