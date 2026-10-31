import type { LocalChunk } from '../upload/types';
import type { RecordingCapture } from './capture';
import { sha256Hex } from './sha256';

/**
 * SIMULATED recorder (demo mode): captures NO audio. It writes small zero-filled placeholder chunks (one per started
 * 10 s of elapsed time) so the Record tab can exercise the real upload queue end to end. The native recorder
 * (`nativeCapture.ts`) implements the same `RecordingCapture` port with expo-audio.
 */
export const SIMULATED_CHUNK_MS = 10_000;
const PLACEHOLDER_BYTES = 1024;

export interface SimulatedCapture extends RecordingCapture {
  readonly simulated: true;
}

export function createSimulatedCapture(): SimulatedCapture {
  const files = new Map<string, Map<number, Uint8Array>>();
  return {
    simulated: true,
    begin: () => Promise.resolve(),
    pause: () => undefined,
    resume: () => undefined,
    isLive: () => true,
    abort: () => Promise.resolve(),
    capture(recordingId, durationMs) {
      const count = Math.max(1, Math.ceil(durationMs / SIMULATED_CHUNK_MS));
      const chunks = new Map<number, Uint8Array>();
      const meta: LocalChunk[] = [];
      for (let seq = 0; seq < count; seq++) {
        const bytes = new Uint8Array(PLACEHOLDER_BYTES);
        chunks.set(seq, bytes);
        meta.push({ seq, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes) });
      }
      files.set(recordingId, chunks);
      return Promise.resolve(meta);
    },
    read(recordingId, seq) {
      const bytes = files.get(recordingId)?.get(seq);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error('Chunk missing.'));
    },
    remove(recordingId) {
      files.delete(recordingId);
      return Promise.resolve();
    },
    exists: (recordingId) => Promise.resolve(files.has(recordingId)),
  };
}
