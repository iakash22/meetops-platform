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

  it('never evicts pending chunks of another (unheld) recording; refuses the new chunk instead', async () => {
    const s = await open({ maxBytes: 30, policy: 'evict-uploaded' });
    await s.putChunk(chunk(0, 10));
    await s.putChunk(chunk(1, 10));
    await s.putChunk(chunk(2, 10));
    await s.putSession({ sessionId: 's2', meta, completed: false });
    expect(await s.putChunk({ ...chunk(0, 15, 9), sessionId: 's2' })).toEqual({
      stored: false,
      reason: 'over-cap',
    });
    expect((await s.listChunks('s1')).map((c) => c.seq)).toEqual([0, 1, 2]);
    expect((await s.getSession('s1'))!.incomplete).toBeUndefined();
  });

  it('deletes a pending chunk only once the server confirmed it (uploaded)', async () => {
    const s = await open({ maxBytes: 20, policy: 'evict-uploaded' });
    await s.putChunk(chunk(0, 10));
    await s.putChunk(chunk(1, 10));
    await s.putSession({ sessionId: 's2', meta, completed: false });
    expect(await s.putChunk({ ...chunk(0, 10, 9), sessionId: 's2' })).toMatchObject({
      stored: false,
    });
    await s.markUploaded('s1', 0);
    expect(await s.putChunk({ ...chunk(0, 10, 9), sessionId: 's2' })).toMatchObject({
      stored: true,
      evictedCount: 1,
      lostPending: 0,
    });
    expect((await s.listChunks()).map((c) => `${c.sessionId}:${c.seq}`)).toEqual(['s1:1', 's2:0']);
  });

  it('pending chunks survive a service-worker restart (reopened IndexedDB)', async () => {
    const factory = new IDBFactory();
    const a = await ChunkStore.open({ maxBytes: 100, policy: 'evict-uploaded' }, factory);
    await a.putSession({ sessionId: 's1', meta, completed: false });
    await a.putChunk(chunk(0, 10));
    a.close();
    const b = await ChunkStore.open({ maxBytes: 100, policy: 'evict-uploaded' }, factory);
    expect((await b.listChunks('s1')).map((c) => [c.seq, c.uploaded])).toEqual([[0, false]]);
  });

  it('evicts uploaded chunks before any unheld pending recording', async () => {
    const s = await open({ maxBytes: 30, policy: 'evict-uploaded' });
    await s.putChunk(chunk(0, 10));
    await s.putChunk(chunk(1, 10));
    await s.markUploaded('s1', 1);
    await s.putSession({ sessionId: 's2', meta, completed: false });
    await s.putChunk({ ...chunk(0, 10, 5), sessionId: 's2' });
    await s.putSession({ sessionId: 's3', meta, completed: false });
    expect(await s.putChunk({ ...chunk(0, 10, 9), sessionId: 's3' })).toMatchObject({
      stored: true,
      evictedCount: 1,
      lostPending: 0,
      damagedSessions: [],
    });
    expect((await s.listChunks()).map((c) => `${c.sessionId}:${c.seq}`)).toEqual([
      's1:0',
      's2:0',
      's3:0',
    ]);
  });

  it('a recording never evicts its own earlier pending chunks (refused instead)', async () => {
    const s = await open({ maxBytes: 30, policy: 'evict-uploaded' });
    await s.putChunk(chunk(0, 10));
    await s.putChunk(chunk(1, 10));
    await s.putChunk(chunk(2, 10));
    expect(await s.putChunk(chunk(3, 10))).toEqual({ stored: false, reason: 'over-cap' });
    expect((await s.listChunks('s1')).map((c) => c.seq)).toEqual([0, 1, 2]);
    expect((await s.getSession('s1'))!.incomplete).toBeUndefined();
    // Its own already-uploaded chunks can still go (no data loss).
    await s.markUploaded('s1', 0);
    expect(await s.putChunk(chunk(3, 10))).toMatchObject({ stored: true, lostPending: 0 });
  });

  it('never evicts pending chunks of a held recording; refuses the new chunk instead', async () => {
    const s = await open({ maxBytes: 30, policy: 'evict-uploaded' });
    await s.putChunk(chunk(0, 10));
    await s.putChunk(chunk(1, 10));
    await s.putSession({
      ...(await s.getSession('s1'))!,
      held: { status: 409, op: 'complete', at: 1 },
    });
    expect(await s.heldBytes()).toBe(20);
    await s.putSession({ sessionId: 's2', meta, completed: false });
    await s.putChunk({ ...chunk(0, 10, 5), sessionId: 's2' });
    await s.putSession({ sessionId: 's3', meta, completed: false });
    // s3 may not evict s2's pending chunk, nor s1's held ones.
    expect(await s.putChunk({ ...chunk(0, 10, 6), sessionId: 's3' })).toEqual({
      stored: false,
      reason: 'over-cap',
    });
    // Held data alone (20 of 30) leaves no room for a 15-byte chunk: refused, held chunks untouched.
    expect(await s.putChunk({ ...chunk(1, 15, 7), sessionId: 's3' })).toEqual({
      stored: false,
      reason: 'over-cap',
    });
    expect((await s.listChunks('s1')).map((c) => c.seq)).toEqual([0, 1]);
    expect((await s.getSession('s1'))!.incomplete).toBeUndefined();
  });

  it('refuses new chunks over the cap with the refuse policy and keeps existing data', async () => {
    const s = await open({ maxBytes: 20, policy: 'refuse' });
    await s.putChunk(chunk(0, 15));
    expect(await s.putChunk(chunk(1, 10))).toEqual({ stored: false, reason: 'over-cap' });
    expect((await s.listChunks()).map((c) => c.seq)).toEqual([0]);
  });

  it('refuses a single chunk larger than the cap under either policy', async () => {
    const s = await open({ maxBytes: 5, policy: 'evict-uploaded' });
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
