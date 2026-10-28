import type { Invoke } from './native-upload-api';
import type { ChunkStore } from './upload-queue';

function isNotFound(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'code' in e && e.code === 'NOT_FOUND';
}

/**
 * Pending chunks in the Rust encrypted disk store (AES-256-GCM, per-device keychain key; ADR-012 3.5) via
 * `chunk_put` / `chunk_get` / `chunk_delete`. Rust caps each chunk at the upload body limit and fails closed when
 * the keychain key is unavailable. Bytes and errors are never logged here.
 */
export function createNativeChunkStore(invoke: Invoke): ChunkStore {
  const seqs = new Map<string, Set<number>>();
  return {
    put: async (id, seq, bytes) => {
      await invoke('chunk_put', { sessionId: id, index: seq, data: Array.from(bytes) });
      if (!seqs.has(id)) seqs.set(id, new Set());
      seqs.get(id)?.add(seq);
    },
    read: async (id, seq) =>
      new Uint8Array(await invoke<number[]>('chunk_get', { sessionId: id, index: seq })),
    remove: async (id) => {
      await invoke('chunk_delete', { sessionId: id });
    },
    // Verified deletion: probe every chunk written this launch; NOT_FOUND on all means the session dir is gone.
    exists: async (id) => {
      for (const seq of seqs.get(id) ?? []) {
        try {
          await invoke('chunk_get', { sessionId: id, index: seq });
          return true;
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }
      seqs.delete(id);
      return false;
    },
  };
}
