import type { ChunkStore } from './chunk-store.js';
import { drainQueue } from './drain.js';
import type { StorageEvent } from './messages.js';
import { MAX_CHUNK_BYTES, MAX_RECORDING_CHUNKS } from './contracts.js';
import { sha256Hex, splitForUpload, toIsoTimestamp, type UploadClient } from './upload.js';

export const MIME_TYPE = 'audio/webm;codecs=opus';
export const TIMESLICE_MS = 5000;

export interface RecorderEvents {
  onStarted(sessionId: string): void;
  onChunk(seq: number): void;
  onStorage(event: StorageEvent): void;
  onStopped(chunkCount: number): void;
  onError(error: string): void;
}

/** Minimal MediaRecorder surface we rely on (injectable for tests). */
export interface RecorderLike {
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecordingHandle {
  sessionId: string;
  stop(): void;
}

/**
 * Starts MediaRecorder on an already-obtained stream. Every timesliced webm/opus chunk is
 * first persisted to the IndexedDB queue (respecting the size cap), then the queue is
 * drained through the upload client. Writes are serialised so seq order is preserved.
 */
export async function startRecording(opts: {
  stream: MediaStream;
  client: UploadClient;
  store: ChunkStore;
  createRecorder: (stream: MediaStream, mimeType: string) => RecorderLike;
  events: RecorderEvents;
  /** Epoch ms (internal clock); sent to the upload API as ISO 8601. */
  startedAt: number;
  /** InitRecordingSession.meetingId (required by contracts v0.2). */
  meetingId: string;
  now?: () => number;
  timeslice?: number;
  /** Defaults to contracts MAX_CHUNK_BYTES (64 MiB). */
  maxChunkBytes?: number;
}): Promise<RecordingHandle> {
  const now = opts.now ?? Date.now;
  const meta = {
    mimeType: MIME_TYPE,
    startedAt: toIsoTimestamp(opts.startedAt),
    source: 'tab' as const,
    meetingId: opts.meetingId,
  };
  const { sessionId } = await opts.client.initSession(meta);
  await opts.store.putSession({ sessionId, meta, completed: false });
  const rec = opts.createRecorder(opts.stream, MIME_TYPE);
  const stopTracks = () => opts.stream.getTracks().forEach((t) => t.stop());
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();

  rec.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    const data = e.data;
    tail = tail.then(async () => {
      // Enforce the per-chunk upload limit by splitting oversized timeslices into several seqs.
      for (const part of splitForUpload(
        await data.arrayBuffer(),
        opts.maxChunkBytes ?? MAX_CHUNK_BYTES,
      )) {
        if (seq >= MAX_RECORDING_CHUNKS)
          throw new Error('Recording reached the maximum chunk count');
        const mySeq = seq++;
        const res = await opts.store.putChunk({
          sessionId,
          seq: mySeq,
          data: part,
          mimeType: MIME_TYPE,
          createdAt: now(),
          sha256: await sha256Hex(part),
        });
        if (!res.stored) {
          await opts.store.markIncomplete(sessionId);
          opts.events.onStorage({ kind: 'refused', seq: mySeq });
          continue;
        }
        if (res.evictedCount > 0) {
          opts.events.onStorage({
            kind: 'evicted',
            count: res.evictedCount,
            bytes: res.evictedBytes,
            lostPending: res.lostPending,
          });
        }
        opts.events.onChunk(mySeq);
      }
      await drainQueue(opts.store, opts.client, sessionId, now);
    });
    tail = tail.catch((err: unknown) => {
      opts.events.onError(err instanceof Error ? err.message : String(err));
    });
  };
  rec.onerror = (e) => {
    stopTracks();
    opts.events.onError(e instanceof Error ? e.message : 'MediaRecorder error');
  };
  rec.onstop = () => {
    stopTracks();
    void (async () => {
      try {
        await tail;
        await opts.store.finalizeSession(sessionId, {
          chunkCount: seq,
          durationMs: now() - opts.startedAt,
        });
        await drainQueue(opts.store, opts.client, sessionId, now);
        opts.events.onStopped(seq);
      } catch (err) {
        opts.events.onError(err instanceof Error ? err.message : String(err));
      }
    })();
  };
  // Stop if the user ends capture from Chrome's own UI or the tab closes.
  opts.stream.getTracks().forEach((t) =>
    t.addEventListener('ended', () => {
      if (rec.state !== 'inactive') rec.stop();
    }),
  );

  rec.start(opts.timeslice ?? TIMESLICE_MS);
  opts.events.onStarted(sessionId);
  return {
    sessionId,
    stop() {
      if (rec.state !== 'inactive') rec.stop();
    },
  };
}
