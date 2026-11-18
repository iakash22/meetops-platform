import type { LocalChunk } from '../upload/types';
import type { RecordingCapture, RecordingDraft } from './capture';
import type { FileChunkStore } from './fileChunkStore';
import { isLiveActivityId, type RecordingLiveActivity } from './liveActivity';
import {
  PAUSED_NOTIFICATION_TITLE,
  RECORDING_NOTIFICATION_BODY,
  RECORDING_NOTIFICATION_TITLE,
} from './recordingIndicator';

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
  /** Starts the notification/service and returns a stable session id, or null if it cannot. */
  start(): string | null;
  /** Updates the ongoing notification for this id. No-op if the id does not match. */
  update(id: string, title: string, body: string): void;
  /** Stops the service/notification for this id. No-op if the id does not match. */
  stop(id: string): void;
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
  sweep(keep?: readonly string[]): Promise<number>;
}

export interface NativeCaptureOptions {
  recorderFiles?: RecorderFileGuard | null;
  /** iOS Live Activity / Dynamic Island (best effort; see liveActivity.ts). */
  liveActivity?: RecordingLiveActivity | null;
}

export interface NativeCapture extends RecordingCapture {
  readonly simulated: false;
  /**
   * Called once at app start (memoized; `begin` waits for it). A file still being recorded when the app died is
   * deleted (unfinalized). A file whose sealing was interrupted is sealed now and enqueued via `enqueue` when the
   * draft is known, otherwise kept encrypted as `held`. Then leftover recorder files are swept. Never resumes capture.
   */
  recoverOnLaunch(
    enqueue?: (r: RecordingDraft & { chunks: LocalChunk[] }) => Promise<void>,
  ): Promise<void>;
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
  const live = options.liveActivity ?? null;
  let active: string | null = null;
  let paused = false;
  let recovery: Promise<void> | null = null;
  const MAX_SEAL_ATTEMPTS = 3;

  let indicatorId: string | null = null;

  const stopIndicator = () => {
    const id = indicatorId;
    indicatorId = null;
    if (!isLiveActivityId(id)) return;
    try {
      indicator?.stop(id);
    } catch {
      // The service may already be gone (Stop from the notification, or it never started).
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

  /** Ends capture. The in-progress marker stays until the file is sealed or deleted (crash safety). */
  const end = async (): Promise<string | null> => {
    active = null;
    paused = false;
    try {
      return await driver.stop();
    } finally {
      stopIndicator();
      live?.end();
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
    // Live Activity Stop (iOS 17+) is the same as the notification Stop.
    onStopRequested: (listener) => {
      const guarded = () => {
        if (active) listener();
      };
      const offs = [indicator?.onStopRequested(guarded), live?.onStopRequested(guarded)];
      return () => offs.forEach((off) => off?.());
    },
    async begin(recordingId) {
      if (active) throw new Error('Already recording.');
      // The launch sweep must finish before a new recorder file exists, or it could delete the live file.
      if (recovery) await recovery.catch(() => undefined);
      if (!(await driver.canRecord())) throw new Error('Microphone permission is required.');
      // R5 fail closed: the encryption self-test runs before the service starts and before the mic opens.
      await store.ready();
      // The foreground service (and its notification) starts before the mic opens; if it can't, nothing records.
      if (indicator) {
        const id = indicator.start();
        if (!isLiveActivityId(id)) {
          throw new Error('The recording notification could not be started.');
        }
        indicatorId = id;
      }
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
      live?.start();
    },
    pause() {
      if (!active || paused) return;
      driver.pause();
      paused = true;
      updateIndicator(PAUSED_NOTIFICATION_TITLE);
      live?.pause();
    },
    resume() {
      if (!active || !paused) return;
      driver.record();
      paused = false;
      updateIndicator(RECORDING_NOTIFICATION_TITLE);
      live?.resume();
    },
    isLive() {
      if (!active) return false;
      return paused || driver.isRecording();
    },
    async capture(recordingId, _durationMs, draft): Promise<LocalChunk[]> {
      if (active !== recordingId) throw new Error('No active recording.');
      const uri = await end();
      if (!uri) {
        await store.setInProgress(null).catch(() => undefined);
        throw new Error('Recording file missing.');
      }
      // From here a kill or failure resumes sealing at the next launch instead of deleting the recording.
      await store
        .setMarker({ uri, phase: 'sealing', recordingId, attempts: 0, draft })
        .catch(() => undefined);
      const chunks = await store.ingest(recordingId, uri);
      await store.setMarker(null).catch(() => undefined);
      return chunks;
    },
    async abort() {
      const uri = driver.currentUri();
      if (active) await end().catch(() => null);
      if (uri) await store.deleteFile(uri).catch(() => undefined);
      const marker = await store.getMarker().catch(() => null);
      if (marker) {
        await store.deleteFile(marker.uri).catch(() => undefined);
        if (marker.recordingId) await store.remove(marker.recordingId).catch(() => undefined);
      }
      await store.setMarker(null).catch(() => undefined);
    },
    recoverOnLaunch(enqueue) {
      recovery ??= (async () => {
        if (driver.isRecording()) await end().catch(() => null);
        const marker = await store.getMarker().catch(() => null);
        if (marker?.phase === 'sealing' && marker.recordingId) {
          const id = marker.recordingId;
          const attempts = (marker.attempts ?? 0) + 1;
          try {
            if (attempts > MAX_SEAL_ATTEMPTS) throw new Error('Gave up sealing.');
            await store.setMarker({ ...marker, attempts });
            const source = await store.manifest(id).catch(() => null);
            const chunks = source ?? (await store.ingest(id, marker.uri));
            const draft = marker.draft as RecordingDraft | undefined;
            if (draft && enqueue) await enqueue({ ...draft, chunks });
            else await store.setHeld([...new Set([...(await store.held()), id])]);
            await store.deleteFile(marker.uri).catch(() => undefined);
            await store.setMarker(null);
          } catch {
            if (attempts > MAX_SEAL_ATTEMPTS) {
              await store.deleteFile(marker.uri).catch(() => undefined);
              await store.remove(id).catch(() => undefined);
              await store.setMarker(null).catch(() => undefined);
            }
            // Otherwise the marker stays (attempt counted) and the next launch retries.
          }
        } else if (marker) {
          // Still recording when the app died: the file is unfinalized and unplayable. Discard (R7).
          await store.deleteFile(marker.uri).catch(() => undefined);
          await store.setMarker(null).catch(() => undefined);
        }
        // Never sweep a file whose sealing is still pending a retry.
        const pending = await store.getMarker().catch(() => null);
        await guard?.sweep(pending ? [pending.uri] : []).catch(() => 0);
        // A crash or kill can leave a "Recording" Live Activity on the lock screen: end it, never resume.
        await live?.endAll();
      })();
      return recovery;
    },
    read: (id, seq) => store.read(id, seq),
    remove: (id) => store.remove(id),
    exists: (id) => store.exists(id),
  };
}
