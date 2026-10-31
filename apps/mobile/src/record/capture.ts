import type { ChunkSource, LocalChunk } from '../upload/types';
import type { NewRecording } from '../upload/uploadQueueEngine';

/** The queue entry minus its chunks. Given to `capture` so a kill mid-seal can still enqueue it at the next launch. */
export type RecordingDraft = Omit<NewRecording, 'chunks'>;

/**
 * Capture port used by the Record tab. The simulated capture (demo mode) and the native expo-audio capture (M4)
 * both implement it. Lifecycle, always from a visible user action and only after consent (R1, R3):
 *
 *   begin(id) -> [pause() / resume()]* -> capture(id, durationMs)   (Stop: finalize into hashed chunks)
 *   abort()                                                          (logout, org switch, crash recovery: discard)
 */
export interface RecordingCapture extends ChunkSource {
  /** True for the demo capture that records no audio. */
  readonly simulated: boolean;
  /** Starts capture. Rejects (and records nothing) without mic permission or, on Android 13+, notifications. */
  begin(recordingId: string): Promise<void>;
  pause(): void;
  resume(): void;
  /**
   * Whether the OS is still capturing while the app thinks it is recording. False after an interruption
   * (phone call, Siri, another app taking the mic): the screen then pauses and the user must resume (R7).
   */
  isLive(): boolean;
  /** Stop: ends capture immediately, then splits the file into hashed chunks for the upload queue. */
  capture(recordingId: string, durationMs: number, draft?: RecordingDraft): Promise<LocalChunk[]>;
  /** Stops any capture and deletes the in-progress file. Never resumes (R7). */
  abort(): Promise<void>;
  /**
   * True only while the Android microphone foreground service is confirmed running with its notification showing.
   * Checked at the moment the app leaves the foreground; otherwise the background pause applies.
   */
  isBackgroundSafe?(): boolean;
  /** Stop pressed outside the app (the Android notification's Stop action). Returns an unsubscribe. */
  onStopRequested?(listener: () => void): () => void;
}
