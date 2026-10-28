import { describe, expect, it } from 'vitest';

import { createNativeChunkStore } from '@/features/recording/native-chunk-store';
import { createNativeUploadApi, type Invoke } from '@/features/recording/native-upload-api';
import {
  RETENTION_MS,
  createUploadQueue,
  type NewRecording,
} from '@/features/recording/upload-queue';

/** Shaped like Rust's `{ code, message }` rejection. */
const rustError = (code: string) => Object.assign(new Error(code), { code });

/** Fake Tauri backend: encrypted store stand-in plus api_request/upload_put. */
function fakeRust(opts: { failPutsOnce?: number } = {}) {
  const disk = new Map<string, number[]>();
  const calls: { cmd: string; args: unknown; headers?: HeadersInit | undefined }[] = [];
  let failPuts = opts.failPutsOnce ?? 0;
  const failDeletes = { n: 0 };
  const invoke = (async (cmd: string, args?: unknown, o?: { headers: HeadersInit }) => {
    calls.push({ cmd, args, headers: o?.headers });
    const a = args as {
      owner: string;
      sessionId: string;
      index: number;
      data: number[];
      path: string;
    };
    const dir = `${a.owner}/${a.sessionId}/`;
    switch (cmd) {
      case 'chunk_put':
        disk.set(`${dir}${a.index}`, a.data);
        return null;
      case 'chunk_get': {
        const v = disk.get(`${dir}${a.index}`);
        if (!v) throw rustError('NOT_FOUND');
        return v;
      }
      case 'chunk_delete':
        if (failDeletes.n > 0) {
          failDeletes.n -= 1;
          throw rustError('INTERNAL');
        }
        for (const k of [...disk.keys()]) if (k.startsWith(dir)) disk.delete(k);
        return null;
      case 'chunk_exists':
        return [...disk.keys()].some((k) => k.startsWith(dir));
      case 'chunk_list':
        return [
          ...new Set(
            [...disk.keys()]
              .filter((k) => k.startsWith(`${a.owner}/`))
              .map((k) => k.split('/')[1] ?? ''),
          ),
        ].sort();
      case 'api_request':
        if (a.path.endsWith('/chunks'))
          return { upload: { url: 'https://storage.example/put', method: 'PUT', headers: {} } };
        if (a.path.includes('/recording-sessions') && !a.path.includes('/rs_1'))
          return { sessionId: 'rs_1' };
        return {};
      case 'upload_put':
        if (failPuts > 0) {
          failPuts -= 1;
          throw rustError('NETWORK');
        }
        return null;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  }) as Invoke;
  return { invoke, disk, calls, failDeletes };
}

const owner = () => 'u1:o1';
const ctx = { isOnline: () => true, identity: () => ({ userId: 'u1', organizationId: 'o1' }) };

const rec = (id: string): NewRecording => ({
  id,
  userId: 'u1',
  organizationId: 'o1',
  meetingId: 'm1',
  meetingTitle: 'Standup',
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-28T00:00:00.000Z',
  durationMs: 1000,
  chunks: [
    { seq: 0, sizeBytes: 3, sha256: 'a'.repeat(64) },
    { seq: 1, sizeBytes: 3, sha256: 'b'.repeat(64) },
  ],
  consent: {} as NewRecording['consent'],
});

describe('native recording upload', () => {
  it('stores chunks via the encrypted Rust store and round-trips bytes', async () => {
    const { invoke, disk } = fakeRust();
    const store = createNativeChunkStore(invoke, owner);
    await store.put('r1', 0, new Uint8Array([1, 2, 3]));
    expect(disk.size).toBe(1);
    expect(await store.read('r1', 0)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.exists('r1')).toBe(true);
    await store.remove('r1');
    expect(await store.exists('r1')).toBe(false);
  });

  it('sends raw bytes to upload_put with the x-meetops-upload header, resumes after a failure, then deletes local chunks', async () => {
    const { invoke, disk, calls } = fakeRust({ failPutsOnce: 1 });
    const chunks = createNativeChunkStore(invoke, owner);
    let t = 0;
    const queue = createUploadQueue(
      createNativeUploadApi(invoke),
      chunks,
      { isOnline: () => true, identity: () => ({ userId: 'u1', organizationId: 'o1' }) },
      () => t,
    );
    await chunks.put('r1', 0, new Uint8Array([1, 2, 3]));
    await chunks.put('r1', 1, new Uint8Array([4, 5, 6]));
    queue.enqueue(rec('r1'));

    await queue.process();
    expect(queue.items()[0]?.state).toBe('pending');
    expect(queue.items()[0]?.lastError).toBeTruthy();

    t = 60_000; // past backoff ("reconnect")
    await queue.process();
    expect(queue.items()).toHaveLength(0);
    expect(disk.size).toBe(0);

    const puts = calls.filter((c) => c.cmd === 'upload_put');
    expect(puts).toHaveLength(3);
    expect(puts[0]?.args).toBeInstanceOf(Uint8Array);
    expect(
      JSON.parse(
        (puts[0]?.headers as Record<string, string> | undefined)?.['x-meetops-upload'] ?? '{}',
      ).url,
    ).toBe('https://storage.example/put');
    // init only once: resume reuses the session
    const inits = calls.filter(
      (c) => c.cmd === 'api_request' && !(c.args as { path: string }).path.includes('rs_1'),
    );
    expect(inits).toHaveLength(1);
  });

  it('re-queues a recording left on disk by an earlier launch and uploads it (restart resume, L-2)', async () => {
    const rust = fakeRust({ failPutsOnce: 1 });
    let t = 0;
    const first = createUploadQueue(
      createNativeUploadApi(rust.invoke),
      createNativeChunkStore(rust.invoke, owner),
      ctx,
      () => t,
    );
    const c1 = createNativeChunkStore(rust.invoke, owner);
    await c1.put('r1', 0, new Uint8Array([1]));
    await c1.put('r1', 1, new Uint8Array([2]));
    first.enqueue(rec('r1'));
    await first.process(); // fails once, metadata persisted
    await Promise.resolve();

    // "Restart": fresh store and queue over the same disk.
    t = 60_000;
    const chunks = createNativeChunkStore(rust.invoke, owner);
    expect(await chunks.exists('r1')).toBe(true);
    const queue = createUploadQueue(createNativeUploadApi(rust.invoke), chunks, ctx, () => t);
    await queue.process();
    expect(queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
  });

  it('deletes leftovers with no metadata and expires old recordings on startup', async () => {
    const rust = fakeRust();
    const c = createNativeChunkStore(rust.invoke, owner);
    await c.put('orphan', 0, new Uint8Array([1]));
    await c.saveMeta(
      'old',
      JSON.stringify({
        ...rec('old'),
        state: 'pending',
        sessionId: null,
        uploadedSeqs: [],
        attempts: 0,
        nextAttemptAt: 0,
        queuedAt: 0,
        lastError: null,
      }),
    );
    await c.put('old', 0, new Uint8Array([1]));
    const queue = createUploadQueue(
      createNativeUploadApi(rust.invoke),
      createNativeChunkStore(rust.invoke, owner),
      ctx,
      () => RETENTION_MS + 1,
    );
    await queue.process();
    expect(queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
  });

  it('keeps discarded and expired records until their delete succeeds (L-3)', async () => {
    const rust = fakeRust();
    const chunks = createNativeChunkStore(rust.invoke, owner);
    let t = 0;
    const queue = createUploadQueue(
      createNativeUploadApi(rust.invoke),
      chunks,
      { ...ctx, isOnline: () => false },
      () => t,
    );
    await chunks.put('d1', 0, new Uint8Array([1]));
    queue.enqueue(rec('d1'));
    await chunks.put('e1', 0, new Uint8Array([1]));
    queue.enqueue(rec('e1'));

    rust.failDeletes.n = 1;
    await queue.discard('d1');
    expect(queue.items().find((i) => i.id === 'd1')?.pendingDelete).toBe(true);

    t = RETENTION_MS + 1;
    rust.failDeletes.n = 2;
    await queue.process(); // d1's retried delete and e1's retention delete both fail: both kept, flagged
    expect(queue.items().map((i) => i.id)).toEqual(['d1', 'e1']);
    expect(queue.items()[0]?.pendingDelete).toBe(true);

    await queue.process();
    expect(queue.items()).toHaveLength(0);
    expect(rust.disk.size).toBe(0);
  });

  it('namespaces every chunk call by the signed-in owner', async () => {
    const rust = fakeRust();
    await createNativeChunkStore(rust.invoke, owner).put('r1', 0, new Uint8Array([1]));
    expect(await createNativeChunkStore(rust.invoke, () => 'u2:o1').exists('r1')).toBe(false);
    await expect(
      createNativeChunkStore(rust.invoke, () => null).put('r1', 0, new Uint8Array([1])),
    ).rejects.toThrow();
  });
});
