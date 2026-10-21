import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { MIME_TYPE, startRecording, type RecorderLike } from '../src/lib/recorder.js';
import { StubUploadClient } from '../src/lib/upload.js';

class FakeRecorder implements RecorderLike {
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  timeslice: number | undefined;
  start(t?: number) {
    this.state = 'recording';
    this.timeslice = t;
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
}

const fakeStream = () => {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
};

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
};

const events = () => ({
  onStarted: vi.fn(),
  onChunk: vi.fn(),
  onStorage: vi.fn(),
  onStopped: vi.fn(),
  onError: vi.fn(),
});

describe('StubUploadClient', () => {
  it('complete reports the contracts RecordingStatus; resume is idempotent', async () => {
    const client = new StubUploadClient(() => 'x');
    const { sessionId } = await client.initSession({ mimeType: 'm', startedAt: 0, source: 'tab' });
    await client.resumeSession(sessionId, { mimeType: 'm', startedAt: 0, source: 'tab' });
    await client.uploadChunk(sessionId, 0, new Blob(['a']));
    expect(client.sessions.get('x')!.chunks.size).toBe(1);
    await expect(client.complete(sessionId, { chunkCount: 1, durationMs: 0 })).resolves.toEqual({
      status: 'uploaded',
    });
  });
});

describe('startRecording', () => {
  it('persists each webm/opus chunk to IndexedDB, uploads in order, finalizes and completes', async () => {
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, new IDBFactory());
    const client = new StubUploadClient(() => 'sess');
    const upload = vi.spyOn(client, 'uploadChunk');
    const rec = new FakeRecorder();
    const { stream, track } = fakeStream();
    const ev = events();
    let mime = '';
    const h = await startRecording({
      stream,
      client,
      store,
      events: ev,
      startedAt: 0,
      now: () => 9000,
      timeslice: 1000,
      createRecorder: (_s, m) => ((mime = m), rec),
    });
    expect(mime).toBe(MIME_TYPE);
    expect(rec.timeslice).toBe(1000);
    expect(ev.onStarted).toHaveBeenCalledWith('sess');
    rec.emit('one');
    rec.emit('two');
    h.stop();
    await settle();
    expect(ev.onChunk.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(upload.mock.calls.map((c) => c[1])).toEqual([0, 1]);
    expect(ev.onStopped).toHaveBeenCalledWith(2);
    expect(client.sessions.get('sess')!.completed).toEqual({ chunkCount: 2, durationMs: 9000 });
    const stored = await store.listChunks('sess');
    expect(stored.map((c) => [c.seq, c.size, c.uploaded])).toEqual([
      [0, 3, true],
      [1, 3, true],
    ]);
    expect((await store.getSession('sess'))!.completed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
  });

  it('keeps chunks queued when upload fails, so a later drain can retry', async () => {
    const store = await ChunkStore.open({ maxBytes: 1000, policy: 'refuse' }, new IDBFactory());
    const client = new StubUploadClient(() => 'sess');
    vi.spyOn(client, 'uploadChunk').mockRejectedValue(new Error('network'));
    const rec = new FakeRecorder();
    const ev = events();
    const h = await startRecording({
      stream: fakeStream().stream,
      client,
      store,
      events: ev,
      startedAt: 0,
      createRecorder: () => rec,
    });
    rec.emit('x');
    h.stop();
    await settle();
    expect(ev.onStopped).toHaveBeenCalledWith(1);
    expect((await store.listChunks('sess')).map((c) => c.uploaded)).toEqual([false]);
    expect((await store.getSession('sess'))!.completed).toBe(false);
  });

  it('reports eviction and refusal through onStorage', async () => {
    const store = await ChunkStore.open({ maxBytes: 4, policy: 'evict-oldest' }, new IDBFactory());
    const client = new StubUploadClient(() => 'sess');
    const rec = new FakeRecorder();
    const ev = events();
    await startRecording({
      stream: fakeStream().stream,
      client,
      store,
      events: ev,
      startedAt: 0,
      createRecorder: () => rec,
    });
    rec.emit('abc');
    rec.emit('de');
    rec.emit('toolong');
    await settle();
    expect(ev.onStorage.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'evicted', count: 1, bytes: 3 },
      { kind: 'refused', seq: 2 },
    ]);
    expect(ev.onChunk.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });
});
