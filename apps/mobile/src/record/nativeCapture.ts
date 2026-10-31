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

export interface NativeCapture extends RecordingCapture {
  readonly simulated: false;
  /** Called once at app start: deletes recorder output left by a crash or kill. Never resumes capture. */
  recoverOnLaunch(): Promise<void>;
}

export function createNativeCapture(driver: AudioDriver, store: FileChunkStore): NativeCapture {
  let active: string | null = null;
  let paused = false;

  const end = async (): Promise<string | null> => {
    active = null;
    paused = false;
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
      if (!uri) throw new Error('Recording file missing.');
      return store.ingest(recordingId, uri);
    },
    async abort() {
      const uri = driver.currentUri();
      if (active) await end().catch(() => null);
      if (uri) await store.deleteFile(uri).catch(() => undefined);
    },
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
