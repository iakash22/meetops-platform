import { describe, expect, it } from 'vitest';

import { createNativeChunkStore } from '@/features/recording/native-chunk-store';
import { createNativeUploadApi, type Invoke } from '@/features/recording/native-upload-api';
import { createUploadQueue, type NewRecording } from '@/features/recording/upload-queue';

/** Shaped like Rust's `{ code, message }` rejection. */
const rustError = (code: string) => Object.assign(new Error(code), { code });

/** Fake Tauri backend: encrypted store stand-in plus api_request/upload_put. */
function fakeRust(opts: { failPutsOnce?: number } = {}) {
  const disk = new Map<string, number[]>();
  const calls: { cmd: string; args: unknown; headers?: HeadersInit | undefined }[] = [];
  let failPuts = opts.failPutsOnce ?? 0;
  const invoke = (async (cmd: string, args?: unknown, o?: { headers: HeadersInit }) => {
    calls.push({ cmd, args, headers: o?.headers });
    const a = args as { sessionId: string; index: number; data: number[]; path: string };
    switch (cmd) {
      case 'chunk_put':
        disk.set(`${a.sessionId}/${a.index}`, a.data);
        return null;
      case 'chunk_get': {
        const v = disk.get(`${a.sessionId}/${a.index}`);
        if (!v) throw rustError('NOT_FOUND');
        return v;
      }
      case 'chunk_delete':
        for (const k of [...disk.keys()]) if (k.startsWith(`${a.sessionId}/`)) disk.delete(k);
        return null;
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
  return { invoke, disk, calls };
}

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
    const store = createNativeChunkStore(invoke);
    await store.put('r1', 0, new Uint8Array([1, 2, 3]));
    expect(disk.size).toBe(1);
    expect(await store.read('r1', 0)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.exists('r1')).toBe(true);
    await store.remove('r1');
    expect(await store.exists('r1')).toBe(false);
  });

  it('sends raw bytes to upload_put with the x-meetops-upload header, resumes after a failure, then deletes local chunks', async () => {
    const { invoke, disk, calls } = fakeRust({ failPutsOnce: 1 });
    const chunks = createNativeChunkStore(invoke);
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
});
