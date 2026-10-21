import { describe, expect, it, vi } from 'vitest';
import { startRecording, type RecorderLike } from '../src/lib/recorder.js';
import { ChunkQueue, StubUploadClient, type UploadClient } from '../src/lib/upload.js';

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

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ChunkQueue', () => {
  it('stub complete reports the contracts RecordingStatus', async () => {
    const client = new StubUploadClient();
    const { sessionId } = await client.initSession({ mimeType: 'x', startedAt: 0, source: 'tab' });
    await expect(client.complete(sessionId, { chunkCount: 0, durationMs: 0 })).resolves.toEqual({
      status: 'uploaded',
    });
  });

  it('uploads chunks in seq order', async () => {
    const client = new StubUploadClient();
    const { sessionId } = await client.initSession({ mimeType: 'x', startedAt: 0, source: 'tab' });
    const q = new ChunkQueue(client, sessionId);
    q.push(new Blob(['a']));
    q.push(new Blob(['bb']));
    await q.flush();
    expect([...client.sessions.get(sessionId)!.chunks.entries()]).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('surfaces upload failures on flush', async () => {
    const client: UploadClient = {
      initSession: vi.fn(),
      uploadChunk: vi.fn().mockRejectedValue(new Error('503')),
      complete: vi.fn(),
    };
    const q = new ChunkQueue(client, 's');
    q.push(new Blob(['a']));
    await expect(q.flush()).rejects.toThrow('503');
  });
});

describe('startRecording', () => {
  it('records webm/opus on a timeslice, uploads chunks and completes', async () => {
    const client = new StubUploadClient();
    const rec = new FakeRecorder();
    const { stream, track } = fakeStream();
    const events = { onStarted: vi.fn(), onChunk: vi.fn(), onStopped: vi.fn(), onError: vi.fn() };
    let mime = '';
    const h = await startRecording({
      stream,
      client,
      events,
      startedAt: 0,
      now: () => 9000,
      timeslice: 1000,
      createRecorder: (_s, m) => ((mime = m), rec),
    });
    expect(mime).toBe('audio/webm;codecs=opus');
    expect(rec.timeslice).toBe(1000);
    expect(events.onStarted).toHaveBeenCalledWith('stub-1');
    rec.emit('one');
    rec.emit('two');
    h.stop();
    await tick();
    await tick();
    expect(events.onChunk).toHaveBeenCalledTimes(2);
    expect(events.onStopped).toHaveBeenCalledWith(2);
    expect(client.sessions.get('stub-1')!.completed).toEqual({ chunkCount: 2, durationMs: 9000 });
    expect(track.stop).toHaveBeenCalled();
  });

  it('aborts the upload session and reports an error if a chunk fails', async () => {
    const client = new StubUploadClient();
    vi.spyOn(client, 'uploadChunk').mockRejectedValue(new Error('network'));
    const abort = vi.spyOn(client, 'abort');
    const rec = new FakeRecorder();
    const events = { onStarted: vi.fn(), onChunk: vi.fn(), onStopped: vi.fn(), onError: vi.fn() };
    const h = await startRecording({
      stream: fakeStream().stream,
      client,
      events,
      startedAt: 0,
      createRecorder: () => rec,
    });
    rec.emit('x');
    h.stop();
    await tick();
    await tick();
    expect(events.onError).toHaveBeenCalledWith('network');
    expect(abort).toHaveBeenCalled();
    expect(events.onStopped).not.toHaveBeenCalled();
  });
});
