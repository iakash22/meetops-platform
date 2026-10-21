import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { drainQueue } from '../src/lib/drain.js';
import { StubUploadClient, type UploadClient } from '../src/lib/upload.js';

const meta = { mimeType: 'audio/webm;codecs=opus', startedAt: 0, source: 'tab' as const };

async function seeded(factory = new IDBFactory()) {
  const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, factory);
  await store.putSession({ sessionId: 'old', meta, completed: false });
  for (const seq of [1, 0, 2]) {
    await store.putChunk({
      sessionId: 'old',
      seq,
      data: new Uint8Array(seq + 1).buffer,
      mimeType: meta.mimeType,
      createdAt: 10 + seq,
    });
  }
  await store.finalizeSession('old', { chunkCount: 3, durationMs: 15000 });
  return { store, factory };
}

describe('drainQueue (restart retry)', () => {
  it('after a restart, re-attaches the session, uploads pending chunks in seq order, completes', async () => {
    const { factory } = await seeded();
    // Simulate a browser/extension restart: fresh store handle and fresh upload client.
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, factory);
    const client = new StubUploadClient();
    const upload = vi.spyOn(client, 'uploadChunk');
    const r = await drainQueue(store, client);
    expect(r).toEqual({ uploaded: 3, completed: 1, failed: 0 });
    expect(upload.mock.calls.map((c) => c[1])).toEqual([0, 1, 2]);
    expect(client.sessions.get('old')!.completed).toEqual({ chunkCount: 3, durationMs: 15000 });
    // Non-durable stub: chunks are kept locally, marked uploaded, and not re-sent.
    expect((await store.listChunks('old')).every((c) => c.uploaded)).toBe(true);
    expect(await drainQueue(store, client)).toEqual({ uploaded: 0, completed: 0, failed: 0 });
  });

  it('deletes local data once a durable client has it', async () => {
    const { store } = await seeded();
    const client = Object.assign(new StubUploadClient(), { durable: true });
    await drainQueue(store, client);
    expect(await store.listChunks()).toEqual([]);
    expect(await store.listSessions()).toEqual([]);
  });

  it('keeps chunks and retries later when an upload fails', async () => {
    const { store } = await seeded();
    const complete = vi.fn(async () => ({ status: 'uploaded' as const }));
    const failing: UploadClient = {
      durable: true,
      initSession: vi.fn(),
      resumeSession: vi.fn(async () => undefined),
      uploadChunk: vi.fn(async (_s: string, seq: number) => {
        if (seq === 1) throw new Error('503');
      }),
      complete,
    };
    expect(await drainQueue(store, failing)).toEqual({ uploaded: 1, completed: 0, failed: 1 });
    expect((await store.listChunks('old')).map((c) => c.seq)).toEqual([1, 2]);
    expect(complete).not.toHaveBeenCalled();
    const ok = Object.assign(new StubUploadClient(), { durable: true });
    expect(await drainQueue(store, ok)).toEqual({ uploaded: 2, completed: 1, failed: 0 });
  });
});
