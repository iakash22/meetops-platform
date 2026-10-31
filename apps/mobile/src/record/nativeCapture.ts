import type { LocalChunk } from '../upload/types';
import type { RecordingCapture } from './capture';
import type { FileChunkStore } from './fileChunkStore';

/**
 * Native recorder (M4) over expo-audio, behind the `RecordingCapture` port. The OS-facing calls sit behind
 * `AudioDriver` so the rules are unit-tested without a device:
 * - `begin` refuses to start without permission (never prompts itself: the Record tab's pre-prompt does that).
 * - Stop ends capture first, then ingests the file into hashed chunks.
 * - An interruption (call, Siri, another app) shows as `isLive() === false`; the screen pauses, never auto-resumes.
 * - `abort` (logout, org switch) and `recoverOnLaunch` (after a crash) discard partial audio; nothing resumes (R7).
 */
export interface AudioDriver {
  /** Mic (and on Android 13+, notification) permission is already granted. */
  canRecord(): Promise<boolean>;
  /** Audio session for capture: playAndRecord, background audio only while recording (iOS). */
  setRecordingMode(active: boolean): Promise<void>;
  prepare(): Promise<void>;
  record(): void;
  pause(): void;
  /** Ends capture and returns the file uri. */
  stop(): Promise<string | null>;
  isRecording(): boolean;
  /** Uri of the current output file, if any (for discarding). */
  currentUri(): string | null;
}

/**
 * R5: the recorder writes a plaintext m4a to its cache file while it records, which can't be encrypted while it's
 * open. To bound that exposure, capture rotates segments: every `segmentMs` of recording the current file is
 * finalized, sealed into encrypted chunks and deleted, and a new file starts. Each finished segment is its own
 * valid m4a and is queued as its own recording session for the same meeting and consent attestation.
 * Rotation costs a short gap (stop + prepare, typically well under a second).
 */
export const SEGMENT_MS = 60_000;

export interface CapturedPart {
  id: string;
  chunks: LocalChunk[];
  durationMs: number;
}

export interface NativeCapture extends RecordingCapture {
  readonly simulated: false;
  /** Called once at app start: deletes recorder output left by a crash or kill. Never resumes capture. */
  recoverOnLaunch(): Promise<void>;
}

export function createNativeCapture(
  driver: AudioDriver,
  store: FileChunkStore,
  options: { segmentMs?: number; now?: () => number } = {},
): NativeCapture {
  const segmentMs = options.segmentMs ?? SEGMENT_MS;
  const now = options.now ?? Date.now;
  let parts: CapturedPart[] = [];
  let segmentRunMs = 0;
  let runStartedAt: number | null = null;
  let rotateTimer: ReturnType<typeof setInterval> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  /** Serializes rotation with stop/abort so the driver never sees overlapping calls. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const segmentElapsed = () => segmentRunMs + (runStartedAt === null ? 0 : now() - runStartedAt);
  const stopTimer = () => {
    if (rotateTimer) clearInterval(rotateTimer);
    rotateTimer = null;
  };
  const rotate = (recordingId: string) =>
    serial(async () => {
      if (active !== recordingId || paused || segmentElapsed() < segmentMs) return;
      const durationMs = segmentElapsed();
      const uri = await driver.stop();
      await driver.prepare();
      await store.setInProgress(driver.currentUri());
      driver.record();
      segmentRunMs = 0;
      runStartedAt = now();
      if (!uri) return;
      const id = `${recordingId}-p${parts.length + 1}`;
      // Seal and delete the finished plaintext segment right away.
      parts.push({ id, chunks: await store.ingest(id, uri), durationMs });
    });
  let active: string | null = null;
  let paused = false;

  const end = async (): Promise<string | null> => {
    stopTimer();
    active = null;
    paused = false;
    runStartedAt = null;
    try {
      return await driver.stop();
    } finally {
      await driver.setRecordingMode(false).catch(() => undefined);
      await store.setInProgress(null).catch(() => undefined);
    }
  };

  return {
    simulated: false,
    async begin(recordingId) {
      if (active) throw new Error('Already recording.');
      if (!(await driver.canRecord())) throw new Error('Microphone permission is required.');
      // R5 fail closed: no working encryption at rest, no recording.
      await store.ready();
      await driver.setRecordingMode(true);
      try {
        await driver.prepare();
        await store.setInProgress(driver.currentUri());
        driver.record();
      } catch (e) {
        await driver.setRecordingMode(false).catch(() => undefined);
        await store.setInProgress(null).catch(() => undefined);
        throw e;
      }
      active = recordingId;
      paused = false;
      parts = [];
      segmentRunMs = 0;
      runStartedAt = now();
      rotateTimer = setInterval(
        () => {
          void rotate(recordingId).catch(() => undefined);
        },
        Math.min(segmentMs, 5_000),
      );
    },
    pause() {
      if (!active || paused) return;
      driver.pause();
      paused = true;
      segmentRunMs = segmentElapsed();
      runStartedAt = null;
    },
    resume() {
      if (!active || !paused) return;
      driver.record();
      paused = false;
      runStartedAt = now();
    },
    takeParts(recordingId) {
      const done = parts.filter((p) => p.id.startsWith(`${recordingId}-p`));
      parts = parts.filter((p) => !done.includes(p));
      return done;
    },
    isLive() {
      if (!active) return false;
      return paused || driver.isRecording();
    },
    capture: (recordingId) =>
      serial(async (): Promise<LocalChunk[]> => {
        if (active !== recordingId) throw new Error('No active recording.');
        const uri = await end();
        if (!uri) throw new Error('Recording file missing.');
        return store.ingest(recordingId, uri);
      }),
    abort: () =>
      serial(async () => {
        const uri = driver.currentUri();
        if (active) await end().catch(() => null);
        if (uri) await store.deleteFile(uri).catch(() => undefined);
        for (const p of parts) await store.remove(p.id).catch(() => undefined);
        parts = [];
      }),
    async recoverOnLaunch() {
      if (driver.isRecording()) await end().catch(() => null);
      const uri = await store.getInProgress().catch(() => null);
      if (uri) await store.deleteFile(uri).catch(() => undefined);
      await store.setInProgress(null).catch(() => undefined);
    },
    read: (id, seq) => store.read(id, seq),
    remove: (id) => store.remove(id),
    exists: (id) => store.exists(id),
  };
}
