import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ChunkStore, normalizeSession } from '../src/lib/chunk-store.js';
import { drainQueue } from '../src/lib/drain.js';
import { StubUploadClient, UploadUrlExpiredError, type UploadClient } from '../src/lib/upload.js';

const meta = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-21T00:00:00.000Z',
  source: 'tab' as const,
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
    expect(r).toEqual({ uploaded: 3, completed: 1, failed: 0 });
    expect(req.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [SID, { seq: 0 }],
      [SID, { seq: 1 }],
      [SID, { seq: 2 }],
    ]);
    expect(complete).toHaveBeenCalledWith(SID, { chunkCount: 3, durationMs: 15000 });
    // Non-durable stub: chunks are kept locally, marked uploaded, and not re-sent.
    expect((await store.listChunks(SID)).every((c) => c.uploaded)).toBe(true);
    expect(await drainQueue(store, client)).toEqual({ uploaded: 0, completed: 0, failed: 0 });
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
    vi.spyOn(client, 'putChunk').mockRejectedValueOnce(new UploadUrlExpiredError());
    expect(await drainQueue(store, client)).toEqual({ uploaded: 3, completed: 1, failed: 0 });
  });

  it('keeps chunks and retries later when an upload fails', async () => {
    const { store } = await seeded();
    const complete = vi.fn(async () => ({ status: 'uploaded' as const }));
    const failing: UploadClient = {
      durable: true,
      initSession: vi.fn(),
      requestChunkUrl: vi.fn(async (_s: string, r: { seq: number }) => ({
        seq: r.seq,
        upload: {
          url: `https://x/${r.seq}`,
          method: 'PUT' as const,
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      })),
      putChunk: vi.fn(async (u: { url: string }) => {
        if (u.url.endsWith('/1')) throw new Error('503');
      }),
      complete,
      abort: vi.fn(),
    };
    expect(await drainQueue(store, failing)).toEqual({ uploaded: 1, completed: 0, failed: 1 });
    expect((await store.listChunks(SID)).map((c) => c.seq)).toEqual([1, 2]);
    expect(complete).not.toHaveBeenCalled();
    expect(await drainQueue(store, durableStub())).toEqual({
      uploaded: 2,
      completed: 1,
      failed: 0,
    });
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
    expect(await drainQueue(store, client)).toEqual({ uploaded: 1, completed: 1, failed: 0 });
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
