import type { LocalChunk } from '../upload/types';

export interface SegmentStopResult {
  chunks: LocalChunk[];
  markerFailed: boolean;
}

/** Older native builds resolve stop() with the bare chunk array. */
export function normalizeStop(r: SegmentStopResult | LocalChunk[]): SegmentStopResult {
  return Array.isArray(r) ? { chunks: r, markerFailed: false } : r;
}
import type { RecordingDraft } from './capture';
import type { FileChunkStore } from './fileChunkStore';
import type { ForegroundIndicator, NativeCapture, RecorderFileGuard } from './nativeCapture';
import { isLiveActivityId } from './liveActivity';
import {
  PAUSED_NOTIFICATION_TITLE,
  RECORDING_NOTIFICATION_BODY,
  RECORDING_NOTIFICATION_TITLE,
} from './recordingIndicator';

/** Native side (modules/chunk-crypto SegmentRecorderModule.kt). Injectable for tests. */
export interface SegmentRecorder {
  start(dir: string, segmentMs: number): Promise<void>;
  pause(): void;
  resume(): void;
  isRecording(): boolean;
  /**
   * Drains the encoder, seals the last segment, returns every chunk in seq order. Current native builds resolve
   * `{ chunks, markerFailed }` (older ones a bare array): `markerFailed` is a sealed recording whose native-stop
   * sentinel write failed; it is still a successful stop.
   */
  stop(): Promise<SegmentStopResult | LocalChunk[]>;
  /** Stops without sealing and deletes the capture's folder. */
  abort(): Promise<void>;
  /** Seals a leftover plaintext segment (trimmed to whole ADTS frames) and lists every chunk. */
  recover(dir: string): Promise<LocalChunk[]>;
  /**
   * True when a native Stop (notification Stop or swipe-away, handled without JS) began for this folder before the
   * process died. Absent on older native builds.
   */
  stoppedNatively?(dir: string): boolean;
}

/** 10 s segments: at most ~10 s of audio is ever plaintext; 4 h is ~1,440 chunks (MAX_CHUNKS is 10,000). */
export const SEGMENT_MS = 10_000;
export const SEGMENT_MIME = 'audio/aac' as const;
const MAX_SEAL_ATTEMPTS = 3;
const safe = (f: () => boolean) => {
  try {
    return f();
  } catch {
    return false;
  }
};

export interface SegmentCaptureOptions {
  /** Mic (and Android 13+ notification) permission already granted. */
  canRecord(): Promise<boolean>;
  indicator?: ForegroundIndicator | null;
  /** Sweeps expo-audio leftovers from older builds at launch. */
  recorderFiles?: RecorderFileGuard | null;
  segmentMs?: number;
}

/**
 * Android capture (ADR-015): records ADTS AAC in short segments, each sealed natively as it closes, so only the
 * open segment is ever plaintext (R5). Same lifecycle and markers as the expo-audio capture (#328):
 * - marker `recording` while capturing: a kill discards the capture (R7, never resumed, never kept);
 * - marker `sealing` (with the draft) from Stop on: a kill resumes at launch (`recover`), then enqueues or holds.
 * Chunks concatenate byte by byte into one `audio/aac` file, so upload hashes and the worker's checks are unchanged.
 */
export function createSegmentCapture(
  native: SegmentRecorder,
  store: FileChunkStore,
  options: SegmentCaptureOptions,
): NativeCapture {
  const indicator = options.indicator ?? null;
  const segmentMs = options.segmentMs ?? SEGMENT_MS;
  let active: string | null = null;
  let paused = false;
  let recovery: Promise<void> | null = null;

  let indicatorId: string | null = null;

  const stopIndicator = () => {
    const id = indicatorId;
    indicatorId = null;
    if (!isLiveActivityId(id)) return;
    try {
      indicator?.stop(id);
    } catch {
      // Already gone.
    }
  };

  const updateIndicator = (title: string) => {
    const id = indicatorId;
    if (!isLiveActivityId(id)) return;
    try {
      indicator?.update(id, title, RECORDING_NOTIFICATION_BODY);
    } catch {
      // Best effort: a failed notification update must not affect capture.
    }
  };

  return {
    simulated: false,
    outputMimeType: SEGMENT_MIME,
    isBackgroundSafe() {
      if (!active || !indicator) return false;
      try {
        return indicator.isConfirmed();
      } catch {
        return false;
      }
    },
    onStopRequested: (listener) =>
      indicator?.onStopRequested(() => {
        if (active) listener();
      }) ?? (() => undefined),
    async begin(recordingId) {
      if (active) throw new Error('Already recording.');
      if (recovery) await recovery.catch(() => undefined);
      if (!(await options.canRecord())) throw new Error('Microphone permission is required.');
      await store.ready();
      const dir = store.chunkDir(recordingId);
      if (indicator) {
        const id = indicator.start();
        if (!isLiveActivityId(id)) {
          throw new Error('The recording notification could not be started.');
        }
        indicatorId = id;
      }
      try {
        await store.setMarker({ uri: dir, phase: 'recording', recordingId });
        await native.start(dir, segmentMs);
      } catch (e) {
        await native.abort().catch(() => undefined);
        await store.remove(recordingId).catch(() => undefined);
        await store.setMarker(null).catch(() => undefined);
        stopIndicator();
        throw e;
      }
      active = recordingId;
      paused = false;
    },
    pause() {
      if (!active || paused) return;
      native.pause();
      paused = true;
      updateIndicator(PAUSED_NOTIFICATION_TITLE);
    },
    resume() {
      if (!active || !paused) return;
      native.resume();
      paused = false;
      updateIndicator(RECORDING_NOTIFICATION_TITLE);
    },
    isLive() {
      if (!active) return false;
      return paused || native.isRecording();
    },
    async capture(recordingId, _durationMs, draft?: RecordingDraft): Promise<LocalChunk[]> {
      if (active !== recordingId) throw new Error('No active recording.');
      active = null;
      paused = false;
      const dir = store.chunkDir(recordingId);
      // From here a kill resumes sealing at the next launch (#328 journal semantics).
      await store
        .setMarker({ uri: dir, phase: 'sealing', recordingId, attempts: 0, draft })
        .catch(() => undefined);
      let chunks: LocalChunk[];
      try {
        const result = normalizeStop(await native.stop());
        chunks = result.chunks;
        if (result.markerFailed) {
          // Sealed fine, but the native-stop sentinel is missing: the manifest below is what keeps this recording
          // across a kill, so it is written exactly as for a normal stop (never treated as a failure).
          console.warn(
            '[segment-capture] native stop marker write failed; keeping the sealed recording',
          );
        }
      } finally {
        stopIndicator();
      }
      if (chunks.length === 0) {
        await store.remove(recordingId).catch(() => undefined);
        await store.setMarker(null).catch(() => undefined);
        throw new Error('Recording file missing.');
      }
      await store.writeManifest(recordingId, chunks);
      await store.setMarker(null).catch(() => undefined);
      return chunks;
    },
    async abort() {
      const was = active;
      active = null;
      paused = false;
      await native.abort().catch(() => undefined);
      stopIndicator();
      const marker = await store.getMarker().catch(() => null);
      const id = marker?.recordingId ?? was;
      if (id) await store.remove(id).catch(() => undefined);
      await store.setMarker(null).catch(() => undefined);
    },
    recoverOnLaunch(enqueue) {
      recovery ??= (async () => {
        const marker = await store.getMarker().catch(() => null);
        const id = marker?.recordingId;
        if (marker?.phase === 'sealing' && id) {
          const attempts = (marker.attempts ?? 0) + 1;
          try {
            if (attempts > MAX_SEAL_ATTEMPTS) throw new Error('Gave up sealing.');
            await store.setMarker({ ...marker, attempts });
            const chunks =
              (await store.manifest(id).catch(() => null)) ??
              (await native.recover(store.chunkDir(id)));
            if (chunks.length === 0) throw new Error('Nothing recorded.');
            await store.writeManifest(id, chunks);
            const d = marker.draft as RecordingDraft | undefined;
            if (d && enqueue) await enqueue({ ...d, mimeType: SEGMENT_MIME, chunks });
            else await store.setHeld([...new Set([...(await store.held()), id])]);
            await store.setMarker(null);
          } catch {
            if (attempts > MAX_SEAL_ATTEMPTS) {
              await store.remove(id).catch(() => undefined);
              await store.setMarker(null).catch(() => undefined);
            }
          }
        } else if (marker && id && safe(() => native.stoppedNatively?.(marker.uri) === true)) {
          // The user stopped natively (notification Stop / swipe-away) and the app died before JS finished Stop:
          // a stop, not an interruption. Keep it, sealed and held (no draft was saved yet), never resumed.
          try {
            const chunks = await native.recover(marker.uri);
            if (chunks.length === 0) throw new Error('Nothing recorded.');
            await store.writeManifest(id, chunks);
            await store.setHeld([...new Set([...(await store.held()), id])]);
          } catch {
            await store.remove(id).catch(() => undefined);
          }
          await store.setMarker(null).catch(() => undefined);
        } else if (marker) {
          // Killed while still recording: discard every segment (R7), sealed or not.
          if (id) await store.remove(id).catch(() => undefined);
          await store.setMarker(null).catch(() => undefined);
        }
        await options.recorderFiles?.sweep([]).catch(() => 0);
      })();
      return recovery;
    },
    read: (id, seq) => store.read(id, seq),
    remove: (id) => store.remove(id),
    exists: (id) => store.exists(id),
  };
}
