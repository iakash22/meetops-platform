import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ChunkStore, type ChunkStoreConfig } from '../src/lib/chunk-store.js';
import { CONSENT } from './helpers/consent.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';

const meta = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-21T00:00:00.000Z',
  source: 'tab' as const,
  consent: CONSENT,
  meetingId: MID,
};
const buf = (n: number) => new Uint8Array(n).fill(7).buffer;

async function open(config: ChunkStoreConfig) {
  const store = await ChunkStore.open(config, new IDBFactory());
  await store.putSession({ sessionId: 's1', meta, completed: false });
  return store;
}

const chunk = (seq: number, size: number, createdAt = seq) => ({
  sessionId: 's1',
  seq,
  data: buf(size),
  mimeType: meta.mimeType,
  createdAt,
});

describe('ChunkStore (IndexedDB)', () => {
  it('persists chunks and data across reopen of the same database', async () => {
    const factory = new IDBFactory();
    const a = await ChunkStore.open({ maxBytes: 100, policy: 'refuse' }, factory);
    await a.putSession({ sessionId: 's1', meta, completed: false });
    await a.putChunk(chunk(0, 10));
    a.close();
    const b = await ChunkStore.open({ maxBytes: 100, policy: 'refuse' }, factory);
    const [c] = await b.listChunks('s1');
    expect(c).toMatchObject({ seq: 0, size: 10, uploaded: false });
    expect(new Uint8Array(c!.data)[0]).toBe(7);
    expect((await b.listSessions()).map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('evicts oldest chunks first to stay under the cap', async () => {
    const s = await open({ maxBytes: 30, policy: 'evict-oldest' });
    await s.putChunk(chunk(0, 10));
    await s.putChunk(chunk(1, 10));
    await s.putChunk(chunk(2, 10));
    const r = await s.putChunk(chunk(3, 15));
    expect(r).toEqual({
      stored: true,
      evictedCount: 2,
      evictedBytes: 20,
      damagedSessions: ['s1'],
      lostPending: 2,
    });
    expect((await s.listChunks()).map((c) => c.seq)).toEqual([2, 3]);
    expect(await s.totalBytes()).toBe(25);
  });

  it('refuses new chunks over the cap with the refuse policy and keeps existing data', async () => {
    const s = await open({ maxBytes: 20, policy: 'refuse' });
    await s.putChunk(chunk(0, 15));
    expect(await s.putChunk(chunk(1, 10))).toEqual({ stored: false, reason: 'over-cap' });
    expect((await s.listChunks()).map((c) => c.seq)).toEqual([0]);
  });

  it('refuses a single chunk larger than the cap under either policy', async () => {
    const s = await open({ maxBytes: 5, policy: 'evict-oldest' });
    expect((await s.putChunk(chunk(0, 6))).stored).toBe(false);
  });

  it('marks uploaded, finalizes and deletes sessions', async () => {
    const s = await open({ maxBytes: 100, policy: 'refuse' });
    await s.putChunk(chunk(0, 1));
    await s.markUploaded('s1', 0);
    expect((await s.listChunks('s1'))[0]!.uploaded).toBe(true);
    await s.finalizeSession('s1', { chunkCount: 1, durationMs: 5 });
    expect((await s.getSession('s1'))!.finalized).toEqual({ chunkCount: 1, durationMs: 5 });
    await s.deleteSession('s1');
    expect(await s.listChunks()).toEqual([]);
    expect(await s.listSessions()).toEqual([]);
  });
});
