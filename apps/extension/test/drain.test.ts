import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ChunkStore, normalizeSession } from '../src/lib/chunk-store.js';
import { INCOMPLETE_ABORT_NOTE, drainQueue } from '../src/lib/drain.js';
import { StubUploadClient, type UploadClient } from '../src/lib/upload.js';
import { CONSENT } from './helpers/consent.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';

const meta = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-21T00:00:00.000Z',
  source: 'tab' as const,
  consent: CONSENT,
  meetingId: MID,
};
const SID = '7d9f2c1e-3b4a-4c5d-8e6f-0a1b2c3d4e5f';

async function seeded(factory = new IDBFactory()) {
  const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, factory);
  await store.putSession({ sessionId: SID, meta, completed: false });
  for (const seq of [1, 0, 2]) {
    await store.putChunk({
      sessionId: SID,
      seq,
      data: new Uint8Array(seq + 1).buffer,
      mimeType: meta.mimeType,
      createdAt: 10 + seq,
    });
  }
  await store.finalizeSession(SID, { chunkCount: 3, durationMs: 15000 });
  return { store, factory };
}

const durableStub = () => Object.assign(new StubUploadClient(), { durable: true });

describe('drainQueue (restart retry)', () => {
  it('after a restart, PUTs pending chunks in seq order via fresh presigned URLs and completes', async () => {
    const { factory } = await seeded();
    // Simulate a browser/extension restart: fresh store handle and fresh upload client.
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, factory);
    const client = new StubUploadClient();
    const req = vi.spyOn(client, 'requestChunkUrl');
    const complete = vi.spyOn(client, 'complete');
    const r = await drainQueue(store, client);
    expect(r).toEqual({ uploaded: 3, completed: 1, aborted: 0, failed: 0, held: 0, skipped: 0 });
    expect(req.mock.calls.map((c) => [c[0], c[1].seq, c[1].sizeBytes])).toEqual([
      [SID, 0, 1],
      [SID, 1, 2],
      [SID, 2, 3],
    ]);
    expect(complete).toHaveBeenCalledWith(SID, {
      chunkCount: 3,
      chunks: [0, 1, 2].map((seq) => ({
        seq,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        sizeBytes: seq + 1,
      })),
      durationMs: 15000,
    });
    // Non-durable stub: chunks are kept locally, marked uploaded, and not re-sent.
    expect((await store.listChunks(SID)).every((c) => c.uploaded)).toBe(true);
    expect(await drainQueue(store, client)).toEqual({
      uploaded: 0,
      completed: 0,
      aborted: 0,
      failed: 0,
      held: 0,
      skipped: 0,
    });
  });

  it('deletes local data once a durable client has it', async () => {
    const { store } = await seeded();
    await drainQueue(store, durableStub());
    expect(await store.listChunks()).toEqual([]);
    expect(await store.listSessions()).toEqual([]);
  });

  it('survives an expired URL by refreshing it', async () => {
    const { store } = await seeded();
    const client = durableStub();
    vi.spyOn(client, 'storage').mockResolvedValueOnce({ status: 403 });
    expect(await drainQueue(store, client)).toEqual({
      uploaded: 3,
      completed: 1,
      aborted: 0,
      failed: 0,
      held: 0,
      skipped: 0,
    });
  });

  it('keeps chunks and retries later when an upload fails', async () => {
    const { store } = await seeded();
    const server = durableStub();
    const real = server.storage;
    let failSeq1 = true;
    const storage = vi.fn(async (r: Parameters<typeof real>[0]) => {
      if (failSeq1 && r.url.includes('/chunks/1?')) return { status: 503 };
      return real(r);
    });
    const client: UploadClient = Object.assign(Object.create(server) as typeof server, {
      storage,
    });
    const complete = vi.spyOn(server, 'complete');
    expect(await drainQueue(store, client)).toEqual({
      uploaded: 1,
      completed: 0,
      aborted: 0,
      failed: 1,
      held: 0,
      skipped: 0,
    });
    expect((await store.listChunks(SID)).map((c) => c.seq)).toEqual([1, 2]);
    expect(complete).not.toHaveBeenCalled();
    failSeq1 = false;
    expect(await drainQueue(store, client)).toEqual({
      uploaded: 2,
      completed: 1,
      aborted: 0,
      failed: 0,
      held: 0,
      skipped: 0,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('pre-v0.2 IndexedDB records', () => {
  it('normalizes an old epoch-ms startedAt to ISO 8601 and still drains the legacy session', async () => {
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, new IDBFactory());
    // Legacy record as the old code wrote it: epoch ms and a 'stub-' (non-UUID) id.
    await store.putSession({
      sessionId: 'stub-legacy',
      meta: { ...meta, startedAt: 1792603499859 as unknown as string },
      completed: false,
    });
    await store.putChunk({
      sessionId: 'stub-legacy',
      seq: 0,
      data: new Uint8Array(2).buffer,
      mimeType: meta.mimeType,
      createdAt: 1,
    });
    await store.finalizeSession('stub-legacy', { chunkCount: 1, durationMs: 5 });
    expect((await store.getSession('stub-legacy'))!.meta.startedAt).toBe(
      new Date(1792603499859).toISOString(),
    );
    const client = new StubUploadClient();
    expect(await drainQueue(store, client)).toEqual({
      uploaded: 1,
      completed: 1,
      aborted: 0,
      failed: 0,
      held: 0,
      skipped: 0,
    });
  });

  it('normalizeSession handles numeric strings and invalid values', () => {
    const base = { sessionId: 'x', completed: false };
    expect(normalizeSession({ ...base, meta: { ...meta, startedAt: '1000' } }).meta.startedAt).toBe(
      '1970-01-01T00:00:01.000Z',
    );
    expect(
      normalizeSession({ ...base, meta: { ...meta, startedAt: 'garbage' } }).meta.startedAt,
    ).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('sessions with eviction/refusal gaps', () => {
  it('aborts with reason local_storage_exhausted instead of completing, and uploads nothing more', async () => {
    const store = await ChunkStore.open({ maxBytes: 5, policy: 'evict-oldest' }, new IDBFactory());
    await store.putSession({ sessionId: SID, meta, completed: false });
    const put = (seq: number, n: number) =>
      store.putChunk({
        sessionId: SID,
        seq,
        data: new Uint8Array(n).buffer,
        mimeType: meta.mimeType,
        createdAt: seq,
      });
    await put(0, 3);
    // A recording never evicts its own pending chunks: seq 1 is refused and the recorder marks the gap.
    expect(await put(1, 3)).toEqual({ stored: false, reason: 'over-cap' });
    await store.markIncomplete(SID);
    expect((await store.getSession(SID))!.incomplete).toEqual({ lostChunks: 1 });
    await store.finalizeSession(SID, { chunkCount: 2, durationMs: 10 });
    const client = new StubUploadClient();
    const abort = vi.spyOn(client, 'abort');
    const complete = vi.spyOn(client, 'complete');
    const storage = vi.spyOn(client, 'storage');
    expect(await drainQueue(store, client)).toEqual({
      uploaded: 0,
      completed: 0,
      aborted: 1,
      failed: 0,
      held: 0,
      skipped: 0,
    });
    expect(abort).toHaveBeenCalledWith(SID, { reason: 'local_storage_exhausted' });
    expect(complete).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect((await store.getSession(SID))!.abortedReason).toBe(INCOMPLETE_ABORT_NOTE);
  });

  it('evicting already-uploaded chunks is not a gap', async () => {
    const store = await ChunkStore.open({ maxBytes: 5, policy: 'evict-oldest' }, new IDBFactory());
    await store.putSession({ sessionId: SID, meta, completed: false });
    await store.putChunk({
      sessionId: SID,
      seq: 0,
      data: new Uint8Array(3).buffer,
      mimeType: meta.mimeType,
      createdAt: 0,
      uploaded: true,
    });
    const r = await store.putChunk({
      sessionId: SID,
      seq: 1,
      data: new Uint8Array(3).buffer,
      mimeType: meta.mimeType,
      createdAt: 1,
    });
    expect(r).toMatchObject({ stored: true, evictedCount: 1, lostPending: 0, damagedSessions: [] });
    expect((await store.getSession(SID))!.incomplete).toBeUndefined();
  });

  it('a refused chunk marks the session incomplete', async () => {
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, new IDBFactory());
    await store.putSession({ sessionId: SID, meta, completed: false });
    await store.markIncomplete(SID);
    await store.finalizeSession(SID, { chunkCount: 1, durationMs: 1 });
    const client = new StubUploadClient();
    expect((await drainQueue(store, client)).aborted).toBe(1);
    expect(client.sessions.get(SID)!.aborted).toBe('local_storage_exhausted');
  });
});
