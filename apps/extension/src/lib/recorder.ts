import type { ChunkStore } from './chunk-store.js';
import { drainQueue } from './drain.js';
import type { StorageEvent } from './messages.js';
import type { AbortReason, ConsentAttestationInput } from '@meetops/contracts/types';
import {
  LOCAL_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MAX_DURATION_MS,
  MAX_RECORDING_CHUNKS,
} from './contract-limits.js';
import { sha256Hex, splitForUpload, toIsoTimestamp, type UploadClient } from './upload.js';

/** Stop every track of a captured stream (best effort; a track that throws does not keep the others live). */
export function stopStreamTracks(stream: { getTracks(): { stop(): void }[] }): void {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      // keep stopping the rest
    }
  }
}

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
  /**
   * Stop without keeping anything: delete the session and its chunks from IndexedDB and abort the
   * upload session with `reason`. Resolves once local data is gone. Fires neither onStopped nor
   * further onChunk events.
   */
  discard(reason: AbortReason): Promise<void>;
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
  /** Contracts v0.4.1 (G11): the user's consent attestation for this meeting. Required by recording-session init. */
  consent: ConsentAttestationInput;
  now?: () => number;
  timeslice?: number;
  /** Defaults to LOCAL_CHUNK_BYTES (8 MiB); never above contracts MAX_CHUNK_BYTES (64 MiB). */
  maxChunkBytes?: number;
  /** Defaults to contracts MAX_DURATION_MS (4 h). The recorder stops itself once this much time has elapsed. */
  maxDurationMs?: number;
  /** Injectable timer for the duration auto-stop (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): Promise<RecordingHandle> {
  const now = opts.now ?? Date.now;
  const meta = {
    mimeType: MIME_TYPE,
    startedAt: toIsoTimestamp(opts.startedAt),
    source: 'tab' as const,
    meetingId: opts.meetingId,
    consent: opts.consent,
  };
  const stopTracks = () => stopStreamTracks(opts.stream);
  let sessionId: string;
  let rec: RecorderLike;
  try {
    ({ sessionId } = await opts.client.initSession(meta));
    await opts.store.putSession({ sessionId, meta, completed: false });
    rec = opts.createRecorder(opts.stream, MIME_TYPE);
  } catch (err) {
    // Fail closed: a recorder that could not start must not leave the tab captured.
    stopTracks();
    throw err;
  }
  let seq = 0;
  let tail: Promise<void> = Promise.resolve();

  let discarded = false;
  const maxDurationMs = Math.min(opts.maxDurationMs ?? MAX_DURATION_MS, MAX_DURATION_MS);
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  // Contracts cap CompleteRecordingSessionRequest.durationMs at MAX_DURATION_MS: stop at the limit (like the
  // MAX_RECORDING_CHUNKS stop) so a recording never runs past what the server accepts.
  const stopAtLimit = () => {
    if (rec.state !== 'inactive') rec.stop();
  };
  const durationTimer = setTimer(
    stopAtLimit,
    Math.max(0, maxDurationMs - (now() - opts.startedAt)),
  );
  rec.ondataavailable = (e) => {
    if (e.data.size === 0 || discarded) return;
    // Belt and braces for throttled timers (suspended offscreen documents): check the clock on every chunk.
    if (now() - opts.startedAt >= maxDurationMs) queueMicrotask(stopAtLimit);
    const data = e.data;
    tail = tail.then(async () => {
      // Enforce the per-chunk upload limit by splitting oversized timeslices into several seqs.
      for (const part of splitForUpload(
        await data.arrayBuffer(),
        Math.min(opts.maxChunkBytes ?? LOCAL_CHUNK_BYTES, MAX_CHUNK_BYTES),
      )) {
        if (discarded) return;
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
    clearTimer(durationTimer);
    stopTracks();
    if (discarded) return;
    void (async () => {
      try {
        await tail;
        await opts.store.finalizeSession(sessionId, {
          chunkCount: seq,
          // The stop lands a moment after the limit; never report more than the contracts accept.
          durationMs: Math.min(Math.max(0, now() - opts.startedAt), maxDurationMs),
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
    async discard(reason) {
      discarded = true;
      clearTimer(durationTimer);
      if (rec.state !== 'inactive') rec.stop();
      stopTracks();
      await tail.catch(() => undefined);
      await opts.store.deleteSession(sessionId);
      await opts.client.abort(sessionId, { reason }).catch(() => undefined);
    },
  };
}
