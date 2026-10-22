import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { drainQueue, type DiscardGuard } from '../src/lib/drain.js';
import {
  addPendingDiscard,
  clearPendingDiscard,
  isPendingDiscard,
  listFailedDiscards,
  listPendingDiscards,
  MAX_DISCARD_ATTEMPTS,
  readPendingDiscards,
  retryPendingDiscards,
  withSessionGate,
} from '../src/lib/pending-discard.js';
import { memoryKV } from '../src/lib/storage.js';
import { StubUploadClient } from '../src/lib/upload.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';

const kvWith = (raw: unknown) => {
  const kv = memoryKV();
  kv.data.set('pendingDiscards', raw);
  return kv;
};

describe('pending-discard marker validation', () => {
  it.each([
    ['a string', A],
    ['an object', { sessionId: A }],
    ['a number', 42],
    ['null', null],
  ])('treats %s as [] without iterating characters, and removes it', async (_, raw) => {
    const kv = kvWith(raw);
    const discard = vi.fn(async () => undefined);
    expect(await listPendingDiscards(kv)).toEqual([]);
    expect(kv.data.has('pendingDiscards')).toBe(false);
    expect(await retryPendingDiscards(kv, discard)).toEqual([]);
    expect(discard).not.toHaveBeenCalled();
  });

  it('drops non-UUID entries from a mixed array and rewrites the cleaned marker', async () => {
    const kv = kvWith([
      A,
      'sess-1',
      '../etc',
      7,
      null,
      { sessionId: 'nope', attempts: 1 },
      { sessionId: B, attempts: 2 },
      { sessionId: C, attempts: -3, failed: 'yes' },
      A,
    ]);
    expect(await readPendingDiscards(kv)).toEqual([
      { sessionId: A, attempts: 0 },
      { sessionId: B, attempts: 2 },
      { sessionId: C, attempts: 0 },
    ]);
    expect(kv.data.get('pendingDiscards')).toEqual([
      { sessionId: A, attempts: 0 },
      { sessionId: B, attempts: 2 },
      { sessionId: C, attempts: 0 },
    ]);
  });

  it('never throws when the storage read fails', async () => {
    const kv = memoryKV();
    kv.get = () => Promise.reject(new Error('quota'));
    expect(await listPendingDiscards(kv)).toEqual([]);
  });
});

describe('discard retry cap', () => {
  it('counts attempts, falls back to a direct delete at the cap, and clears on success', async () => {
    const kv = memoryKV();
    await addPendingDiscard(kv, A);
    const discard = vi.fn(async () => Promise.reject(new Error('abort down')));
    const del = vi.fn(async () => undefined);
    for (let i = 1; i < MAX_DISCARD_ATTEMPTS; i++) {
      expect(await retryPendingDiscards(kv, discard, del)).toEqual([A]);
      expect(await readPendingDiscards(kv)).toEqual([{ sessionId: A, attempts: i }]);
    }
    expect(del).not.toHaveBeenCalled();
    expect(await retryPendingDiscards(kv, discard, del)).toEqual([]);
    expect(del).toHaveBeenCalledWith(A);
  });

  it('marks the session failed when the fallback also fails, never retries it, and keeps the others going', async () => {
    const kv = memoryKV();
    await addPendingDiscard(kv, A);
    await addPendingDiscard(kv, B);
    const discard = vi.fn(async (id: string) => {
      if (id === A) throw new Error('idb blocked');
    });
    const del = vi.fn(async () => Promise.reject(new Error('still blocked')));
    expect(await retryPendingDiscards(kv, discard, del)).toEqual([A]); // B discarded on round 1
    for (let i = 1; i < MAX_DISCARD_ATTEMPTS; i++) await retryPendingDiscards(kv, discard, del);
    expect(await listFailedDiscards(kv)).toEqual([A]);
    const calls = discard.mock.calls.length;
    await retryPendingDiscards(kv, discard, del);
    expect(discard.mock.calls.length).toBe(calls); // given up: not retried
    expect(await isPendingDiscard(kv, A)).toBe(true); // ...but still never uploaded
    await addPendingDiscard(kv, C);
    expect(await retryPendingDiscards(kv, discard, del)).toEqual([A]); // C still processed
  });
});

async function storeWith(...ids: string[]) {
  const store = await ChunkStore.open({ maxBytes: 10_000, policy: 'refuse' }, new IDBFactory());
  const meta = {
    mimeType: 'audio/webm',
    startedAt: new Date(0).toISOString(),
    source: 'tab' as const,
    meetingId: MID,
  };
  for (const sessionId of ids) {
    await store.putSession({ sessionId, meta, completed: false });
    for (const seq of [0, 1, 2]) {
      await store.putChunk({
        sessionId,
        seq,
        data: new ArrayBuffer(4),
        mimeType: 'audio/webm',
        createdAt: seq,
      });
    }
    await store.finalizeSession(sessionId, { chunkCount: 3, durationMs: 3000 });
  }
  return store;
}

describe('drain with discard markers', () => {
  const guardFor = (kv: ReturnType<typeof memoryKV>): DiscardGuard => ({
    isMarked: (id) => isPendingDiscard(kv, id),
    gate: withSessionGate,
  });

  it('skips only the marked session and drains the others', async () => {
    const kv = memoryKV();
    await addPendingDiscard(kv, A);
    const store = await storeWith(A, B);
    const client = new StubUploadClient();
    const req = vi.spyOn(client, 'requestChunkUrl');
    const complete = vi.spyOn(client, 'complete');
    const r = await drainQueue(store, client, undefined, Date.now, guardFor(kv));
    expect(r).toMatchObject({ uploaded: 3, completed: 1, skipped: 1, failed: 0 });
    expect(req.mock.calls.every((c) => c[0] === B)).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(B, expect.anything());
  });

  it('a session marked during the drain gets no PUT and no complete after the mark', async () => {
    const kv = memoryKV();
    const store = await storeWith(A);
    const client = new StubUploadClient();
    let marking: Promise<void> | undefined;
    const events: string[] = [];
    const orig = client.requestChunkUrl.bind(client);
    vi.spyOn(client, 'requestChunkUrl').mockImplementation(async (id, req) => {
      events.push(`put:${req.seq}`);
      // Mark while this PUT is in flight: marking waits on the gate until the PUT finishes.
      if (req.seq === 0) marking = addPendingDiscard(kv, id).then(() => void events.push('marked'));
      return orig(id, req);
    });
    const complete = vi.spyOn(client, 'complete');
    const r = await drainQueue(store, client, undefined, Date.now, guardFor(kv));
    await marking;
    expect(events).toEqual(['put:0', 'marked']);
    expect(complete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ uploaded: 1, skipped: 1, completed: 0 });
    expect(await listPendingDiscards(kv)).toEqual([A]);
  });
});

describe('pendingDiscards serial queue (two sessions racing)', () => {
  // Yield between get and set so unserialised read-modify-writes would interleave.
  const slowKV = () => {
    const kv = memoryKV();
    const tick = () => new Promise((r) => setTimeout(r, 5));
    return Object.assign(kv, {
      get: async <T>(k: string) => {
        const v = structuredClone(kv.data.get(k));
        await tick();
        return v as T | undefined;
      },
    });
  };

  it('a retry clearing A while B is added keeps B', async () => {
    const kv = slowKV();
    await addPendingDiscard(kv, A);
    const discard = vi.fn(async () => undefined);
    await Promise.all([retryPendingDiscards(kv, discard), addPendingDiscard(kv, B)]);
    expect(discard).toHaveBeenCalledWith(A);
    expect(await listPendingDiscards(kv)).toContain(B);
    expect(await listPendingDiscards(kv)).not.toContain(A);
  });

  it('concurrent clearPendingDiscard(A) and addPendingDiscard(B) keeps B and removes A', async () => {
    const kv = slowKV();
    await addPendingDiscard(kv, A);
    await Promise.all([clearPendingDiscard(kv, A), addPendingDiscard(kv, B)]);
    expect(await listPendingDiscards(kv)).toEqual([B]);
  });

  it('concurrent adds keep both', async () => {
    const kv = slowKV();
    await Promise.all([addPendingDiscard(kv, A), addPendingDiscard(kv, B)]);
    expect((await listPendingDiscards(kv)).sort()).toEqual([A, B].sort());
  });

  it('aborts the server session (best effort) before the fallback local delete', async () => {
    const kv = memoryKV();
    kv.data.set('pendingDiscards', [{ sessionId: A, attempts: MAX_DISCARD_ATTEMPTS - 1 }]);
    const order: string[] = [];
    await retryPendingDiscards(
      kv,
      async () => {
        throw new Error('x');
      },
      async () => {
        order.push('delete');
      },
      async () => {
        order.push('abort');
        throw new Error('offline');
      },
    );
    expect(order).toEqual(['abort', 'delete']);
    expect(await listPendingDiscards(kv)).toEqual([]);
  });
});
