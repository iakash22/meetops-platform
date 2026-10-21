import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { MIME_TYPE, startRecording, type RecorderLike } from '../src/lib/recorder.js';
import { StubUploadClient, UUID_RE } from '../src/lib/upload.js';

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
  for (let i = 0; i < 80; i++) await new Promise((r) => setTimeout(r, 0));
};

const events = () => ({
  onStarted: vi.fn(),
  onChunk: vi.fn(),
  onStorage: vi.fn(),
  onStopped: vi.fn(),
  onError: vi.fn(),
});

const newStore = (maxBytes = 1000, policy: 'refuse' | 'evict-oldest' = 'refuse') =>
  ChunkStore.open({ maxBytes, policy }, new IDBFactory());

describe('startRecording', () => {
  it('inits with ISO startedAt, persists chunks, PUTs them in order, completes', async () => {
    const store = await newStore();
    const client = new StubUploadClient();
    const init = vi.spyOn(client, 'initSession');
    const put = vi.spyOn(client, 'putChunk');
    const complete = vi.spyOn(client, 'complete');
    const rec = new FakeRecorder();
    const { stream, track } = fakeStream();
    const ev = events();
    let mime = '';
    const h = await startRecording({
      stream,
      client,
      store,
      events: ev,
      startedAt: Date.UTC(2026, 9, 21, 17, 30),
      now: () => Date.UTC(2026, 9, 21, 17, 30, 9),
      timeslice: 1000,
      createRecorder: (_s, m) => ((mime = m), rec),
    });
    expect(mime).toBe(MIME_TYPE);
    expect(rec.timeslice).toBe(1000);
    expect(init).toHaveBeenCalledWith({
      mimeType: MIME_TYPE,
      startedAt: '2026-10-21T17:30:00.000Z',
      source: 'tab',
    });
    expect(h.sessionId).toMatch(UUID_RE);
    expect(ev.onStarted).toHaveBeenCalledWith(h.sessionId);
    rec.emit('one');
    rec.emit('two');
    h.stop();
    await settle();
    expect(ev.onChunk.mock.calls.map((c) => c[0])).toEqual([0, 1]);
    expect(put).toHaveBeenCalledTimes(2);
    expect([...client.sessions.get(h.sessionId)!.chunks.keys()]).toEqual([0, 1]);
    expect(complete).toHaveBeenCalledWith(h.sessionId, { chunkCount: 2, durationMs: 9000 });
    expect(ev.onStopped).toHaveBeenCalledWith(2);
    const stored = await store.listChunks(h.sessionId);
    expect(stored.map((c) => [c.seq, c.size, c.uploaded])).toEqual([
      [0, 3, true],
      [1, 3, true],
    ]);
    expect((await store.getSession(h.sessionId))!.meta.startedAt).toBe('2026-10-21T17:30:00.000Z');
    expect(track.stop).toHaveBeenCalled();
  });

  it('splits a timeslice larger than the per-chunk limit into consecutive seqs', async () => {
    const store = await newStore();
    const client = new StubUploadClient();
    const rec = new FakeRecorder();
    const ev = events();
    const h = await startRecording({
      stream: fakeStream().stream,
      client,
      store,
      events: ev,
      startedAt: 0,
      maxChunkBytes: 4,
      createRecorder: () => rec,
    });
    rec.emit('abcdefghij'); // 10 bytes -> 4 + 4 + 2
    rec.emit('xy');
    h.stop();
    await settle();
    expect([...client.sessions.get(h.sessionId)!.chunks.entries()]).toEqual([
      [0, 4],
      [1, 4],
      [2, 2],
      [3, 2],
    ]);
    expect(ev.onStopped).toHaveBeenCalledWith(4);
  });

  it('keeps chunks queued when the PUT fails, so a later drain can retry', async () => {
    const store = await newStore();
    const client = new StubUploadClient();
    vi.spyOn(client, 'putChunk').mockRejectedValue(new Error('network'));
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
    expect((await store.listChunks(h.sessionId)).map((c) => c.uploaded)).toEqual([false]);
    expect((await store.getSession(h.sessionId))!.completed).toBe(false);
  });

  it('aborts (not completes) a session that recorded no chunks', async () => {
    const store = await newStore();
    const client = new StubUploadClient();
    const abort = vi.spyOn(client, 'abort');
    const rec = new FakeRecorder();
    const h = await startRecording({
      stream: fakeStream().stream,
      client,
      store,
      events: events(),
      startedAt: 0,
      createRecorder: () => rec,
    });
    h.stop();
    await settle();
    expect(abort).toHaveBeenCalledWith(h.sessionId, { reason: 'user_stopped' });
    expect(client.sessions.get(h.sessionId)!.completed).toBeUndefined();
  });

  it('reports eviction and refusal through onStorage', async () => {
    const store = await newStore(4, 'evict-oldest');
    const client = new StubUploadClient();
    const rec = new FakeRecorder();
    const ev = events();
    await startRecording({
      stream: fakeStream().stream,
      client,
      store,
      events: ev,
      startedAt: 0,
      maxChunkBytes: 100,
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
