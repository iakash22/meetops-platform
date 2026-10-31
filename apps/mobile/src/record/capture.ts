import type { ChunkSource, LocalChunk } from '../upload/types';

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
  capture(recordingId: string, durationMs: number): Promise<LocalChunk[]>;
  /**
   * Finished earlier segments of the recording (native capture rotates files to bound plaintext at rest, R5).
   * Each is queued as its own recording session. Call after `capture`.
   */
  takeParts?(recordingId: string): { id: string; chunks: LocalChunk[]; durationMs: number }[];
  /** Stops any capture and deletes the in-progress file. Never resumes (R7). */
  abort(): Promise<void>;
}
