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

/** Visible OS recording indicator (Android microphone foreground service with Stop/Open). */
export interface ForegroundIndicator {
  start(): void;
  stop(): void;
  /** The service is running and its notification is confirmed showing. */
  isConfirmed(): boolean;
  onStopRequested(listener: () => void): () => void;
}

/**
 * The recorder's own output file (plaintext while recording; expo-audio 0.3 can't write elsewhere or encrypt).
 * - `protect`: iOS sets backup exclusion + file protection on the file right after `prepare`; false = fail closed.
 * - `sweep`: deletes any recorder output left in the cache (crash, kill, older build). Run at launch.
 */
export interface RecorderFileGuard {
  protect(uri: string): Promise<boolean>;
  sweep(): Promise<number>;
}

export interface NativeCaptureOptions {
  recorderFiles?: RecorderFileGuard | null;
}

export interface NativeCapture extends RecordingCapture {
  readonly simulated: false;
  /** Called once at app start: deletes recorder output left by a crash or kill. Never resumes capture. */
  recoverOnLaunch(): Promise<void>;
}

/**
 * One recording = one recorder file = one upload (no segments; see docs/mobile/security-review.md R5 for why
 * segment rotation needs a server change). The plaintext recorder file exists only between `begin` and Stop: it's
 * marked in-progress, protected (iOS), sealed into encrypted chunks at Stop and deleted, and swept at launch.
 */
export function createNativeCapture(
  driver: AudioDriver,
  store: FileChunkStore,
  indicator: ForegroundIndicator | null = null,
  options: NativeCaptureOptions = {},
): NativeCapture {
  const guard = options.recorderFiles ?? null;
  let active: string | null = null;
  let paused = false;

  const stopIndicator = () => {
    try {
      indicator?.stop();
    } catch {
      // The service may already be gone (Stop from the notification, or it never started).
    }
  };

  /** Ends capture. The in-progress marker stays until the file is sealed or deleted (crash safety). */
  const end = async (): Promise<string | null> => {
    active = null;
    paused = false;
    try {
      return await driver.stop();
    } finally {
      stopIndicator();
      await driver.setRecordingMode(false).catch(() => undefined);
    }
  };

  return {
    simulated: false,
    isBackgroundSafe() {
      if (!active || !indicator) return false;
      try {
        return indicator.isConfirmed();
      } catch {
        return false;
      }
    },
    // Only an active capture reacts, so a late or repeated event never stops anything twice.
    onStopRequested: (listener) =>
      indicator?.onStopRequested(() => {
        if (active) listener();
      }) ?? (() => undefined),
    async begin(recordingId) {
      if (active) throw new Error('Already recording.');
      if (!(await driver.canRecord())) throw new Error('Microphone permission is required.');
      // R5 fail closed: the encryption self-test runs before the service starts and before the mic opens.
      await store.ready();
      // The foreground service (and its notification) starts before the mic opens; if it can't, nothing records.
      indicator?.start();
      try {
        await driver.setRecordingMode(true);
        await driver.prepare();
        const uri = driver.currentUri();
        if (!uri) throw new Error('The recorder did not create an output file.');
        await store.setInProgress(uri);
        if (guard && !(await guard.protect(uri)))
          throw new Error('Could not protect the recording file.');
        driver.record();
      } catch (e) {
        // prepare() may already have created an (empty) recorder file: release the recorder and delete it.
        const leftover = driver.currentUri();
        await driver.stop().catch(() => null);
        if (leftover) await store.deleteFile(leftover).catch(() => undefined);
        await driver.setRecordingMode(false).catch(() => undefined);
        await store.setInProgress(null).catch(() => undefined);
        stopIndicator();
        throw e;
      }
      active = recordingId;
      paused = false;
    },
    pause() {
      if (!active || paused) return;
      driver.pause();
      paused = true;
    },
    resume() {
      if (!active || !paused) return;
      driver.record();
      paused = false;
    },
    isLive() {
      if (!active) return false;
      return paused || driver.isRecording();
    },
    async capture(recordingId): Promise<LocalChunk[]> {
      if (active !== recordingId) throw new Error('No active recording.');
      const uri = await end();
      if (!uri) {
        await store.setInProgress(null).catch(() => undefined);
        throw new Error('Recording file missing.');
      }
      try {
        // Seal first; only then clear the marker (ingest deletes the plaintext file either way).
        return await store.ingest(recordingId, uri);
      } finally {
        await store.setInProgress(null).catch(() => undefined);
      }
    },
    async abort() {
      const uri = driver.currentUri();
      if (active) await end().catch(() => null);
      if (uri) await store.deleteFile(uri).catch(() => undefined);
      await store.setInProgress(null).catch(() => undefined);
    },
    async recoverOnLaunch() {
      if (driver.isRecording()) await end().catch(() => null);
      const uri = await store.getInProgress().catch(() => null);
      if (uri) await store.deleteFile(uri).catch(() => undefined);
      await store.setInProgress(null).catch(() => undefined);
      await guard?.sweep().catch(() => 0);
    },
    read: (id, seq) => store.read(id, seq),
    remove: (id) => store.remove(id),
    exists: (id) => store.exists(id),
  };
}
