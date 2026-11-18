import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_CHECK_FAILED_MESSAGE,
  PAIRING_CHECK_FAILED_MESSAGE,
  PAIRING_REQUIRED_MESSAGE,
  handleBackgroundMessage,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { loadState } from '../src/lib/recorder-state.js';
import {
  QUOTA_CHECK_FAILED_MESSAGE,
  QUOTA_FULL_START_MESSAGE,
  QUOTA_LOW_MESSAGE,
} from '../src/lib/storage-quota.js';
import { PENDING_CHECK_FAILED_MESSAGE, PENDING_FULL_START_MESSAGE } from '../src/lib/drain.js';
import { LOCAL_RECORDING_CHUNK_BYTES } from '../src/lib/contract-limits.js';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { makeDeps } from './helpers/bg-deps.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const GRANT = { meetingId: MID, method: 'all_parties_consented' as const };
const popup = { fromSelf: true, fromOffscreen: false, fromPopup: true };
const bg = <T extends object>(m: T) => ({ target: 'background', ...m });
const MB = 1024 * 1024;

async function start(deps: BackgroundDeps, streamId = 's') {
  await handleBackgroundMessage(deps, bg({ type: 'ACK_CONSENT', tabId: 3, ...GRANT }), popup);
  return handleBackgroundMessage(
    deps,
    bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId }),
    popup,
  );
}

describe('Start fails closed', () => {
  it('refuses when not paired, with a clear message', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, checkPairing: async () => false });
    expect(r).toEqual({ ok: false, error: PAIRING_REQUIRED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses when the pairing check throws', async () => {
    const { deps } = makeDeps();
    const r = await start({
      ...deps,
      checkPairing: () => Promise.reject(new Error('storage.session unavailable')),
    });
    expect(r).toEqual({ ok: false, error: PAIRING_CHECK_FAILED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('treats a non-true pairing result as unpaired', async () => {
    const { deps } = makeDeps();
    const r = await start({
      ...deps,
      checkPairing: (async () => 'yes') as unknown as () => Promise<boolean>,
    });
    expect(r).toEqual({ ok: false, error: PAIRING_REQUIRED_MESSAGE });
  });

  it('refuses when reading consent throws (never treated as consent)', async () => {
    const { deps } = makeDeps();
    await handleBackgroundMessage(deps, bg({ type: 'ACK_CONSENT', tabId: 3, ...GRANT }), popup);
    const get = deps.kv.get.bind(deps.kv);
    vi.spyOn(deps.kv, 'get').mockImplementation(async (k: string) => {
      if (k.startsWith('consent:')) throw new Error('read failed');
      return get(k);
    });
    const r = await handleBackgroundMessage(
      deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId: 's' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: CONSENT_CHECK_FAILED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('starts when paired with consent', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, checkPairing: async () => true });
    expect(r.ok).toBe(true);
    expect(deps.ensureOffscreen).toHaveBeenCalled();
  });
});

describe('Start storage quota', () => {
  it('refuses when the browser quota has less than one local chunk free', async () => {
    const { deps } = makeDeps();
    const r = await start({
      ...deps,
      storageQuota: async () => ({ usage: 100 * MB - 1 * MB, quota: 100 * MB }),
    });
    expect(r).toEqual({ ok: false, error: QUOTA_FULL_START_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses when the quota estimate errors', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, storageQuota: () => Promise.reject(new Error('x')) });
    expect(r).toEqual({ ok: false, error: QUOTA_CHECK_FAILED_MESSAGE });
  });

  it('refuses when the quota is unknown (0 of 0), failing closed', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, storageQuota: async () => ({ usage: 0, quota: 0 }) });
    expect(r).toEqual({ ok: false, error: QUOTA_CHECK_FAILED_MESSAGE });
  });

  it('starts but warns the user when quota is low', async () => {
    const { deps } = makeDeps();
    const d = { ...deps, storageQuota: async () => ({ usage: 1900 * MB, quota: 2000 * MB }) };
    const r = await start(d);
    expect(r.ok).toBe(true);
    expect((await loadState(deps.kv)).storageWarning).toBe(QUOTA_LOW_MESSAGE);
  });
});

describe('Start fails closed on missing or broken checks', () => {
  it('refuses when the pairing dependency is missing (never skipped)', async () => {
    const { deps } = makeDeps();
    const d = { ...deps, checkPairing: undefined } as unknown as BackgroundDeps;
    const r = await start(d);
    expect(r).toEqual({ ok: false, error: PAIRING_CHECK_FAILED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses when the quota dependency is missing', async () => {
    const { deps } = makeDeps();
    const d = { ...deps, storageQuota: undefined } as unknown as BackgroundDeps;
    expect(await start(d)).toEqual({ ok: false, error: QUOTA_CHECK_FAILED_MESSAGE });
  });

  it('refuses when the pending-storage dependency is missing or throws', async () => {
    const { deps } = makeDeps();
    const missing = { ...deps, pendingStorage: undefined } as unknown as BackgroundDeps;
    expect(await start(missing)).toEqual({ ok: false, error: PENDING_CHECK_FAILED_MESSAGE });
    const throws = { ...deps, pendingStorage: () => Promise.reject(new Error('idb')) };
    expect(await start(throws, 's2')).toEqual({ ok: false, error: PENDING_CHECK_FAILED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses on a nonsensical pending-storage answer', async () => {
    const { deps } = makeDeps();
    const d = { ...deps, pendingStorage: async () => ({ pendingBytes: NaN, capBytes: 0 }) };
    expect(await start(d)).toEqual({ ok: false, error: PENDING_CHECK_FAILED_MESSAGE });
  });
});

describe('Start vs unheld pending chunks (never evicted)', () => {
  const cap = 500 * MB;

  it('refuses when queued (not held) pending chunks leave less than one chunk of room', async () => {
    const { deps } = makeDeps();
    const d = {
      ...deps,
      heldRecordings: async () => ({ count: 0, closed: 0 }),
      pendingStorage: async () => ({
        pendingBytes: cap - LOCAL_RECORDING_CHUNK_BYTES + 1,
        capBytes: cap,
      }),
    };
    expect(await start(d)).toEqual({ ok: false, error: PENDING_FULL_START_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('starts when exactly one chunk of room is left', async () => {
    const { deps } = makeDeps();
    const d = {
      ...deps,
      pendingStorage: async () => ({
        pendingBytes: cap - LOCAL_RECORDING_CHUNK_BYTES,
        capBytes: cap,
      }),
    };
    expect((await start(d)).ok).toBe(true);
  });

  it('counts held and queued pending chunks, never uploaded ones', async () => {
    const store = await ChunkStore.open(
      { maxBytes: 1000, policy: 'evict-uploaded' },
      new IDBFactory(),
    );
    const base = { mimeType: 'audio/webm', createdAt: 1, sha256: 'a'.repeat(64) };
    await store.putChunk({ ...base, sessionId: 'p1', seq: 0, data: new ArrayBuffer(100) });
    await store.putChunk({ ...base, sessionId: 'p2', seq: 0, data: new ArrayBuffer(50) });
    await store.putChunk({
      ...base,
      sessionId: 'u1',
      seq: 0,
      data: new ArrayBuffer(300),
      uploaded: true,
    });
    expect(await store.pendingBytes()).toBe(150);
    // An uploaded chunk is evicted to make room; pending ones survive.
    const r = await store.putChunk({
      ...base,
      sessionId: 'p3',
      seq: 0,
      data: new ArrayBuffer(800),
    });
    expect(r).toMatchObject({ stored: true, lostPending: 0, evictedCount: 1 });
    expect(await store.pendingBytes()).toBe(950);
    // No uploaded chunk left to evict: the new chunk is refused, pending data is kept.
    const refused = await store.putChunk({
      ...base,
      sessionId: 'p4',
      seq: 0,
      data: new ArrayBuffer(100),
    });
    expect(refused).toEqual({ stored: false, reason: 'over-cap' });
    expect(await store.pendingBytes()).toBe(950);
  });
});
