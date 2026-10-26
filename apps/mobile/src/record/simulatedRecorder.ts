import type { ChunkSource, LocalChunk } from '../upload/types';
import { sha256Hex } from './sha256';

/**
 * SIMULATED recorder: captures NO audio. It writes small zero-filled placeholder chunks (one per started
 * 10 s of elapsed time) so the Record tab can exercise the real upload queue end to end. The M4 native
 * recorder (expo-audio, lockfile slot) replaces it behind the same `ChunkSource` port.
 */
export const SIMULATED_CHUNK_MS = 10_000;
const PLACEHOLDER_BYTES = 1024;

export interface SimulatedCapture extends ChunkSource {
  readonly simulated: true;
  /** "Records" `durationMs` worth of placeholder chunks for `recordingId`. */
  capture(recordingId: string, durationMs: number): Promise<LocalChunk[]>;
}

export function createSimulatedCapture(): SimulatedCapture {
  const files = new Map<string, Map<number, Uint8Array>>();
  return {
    simulated: true,
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
