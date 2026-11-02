import type { Invoke } from './native-upload-api';
import type { ChunkStore, StoredRecording } from './upload-queue';

/** Reserved chunk index holding the (encrypted) queue metadata for a recording. */
export const META_INDEX = 0xffffffff;

/** IPC header with the chunk slot; the bytes themselves go as the raw invoke body (never a JSON number array). */
export const CHUNK_HEADER = 'x-meetops-chunk';

const putRaw = (invoke: Invoke, sessionId: string, index: number, bytes: Uint8Array) =>
  invoke('chunk_put', bytes, {
    headers: { [CHUNK_HEADER]: JSON.stringify({ sessionId, index }) },
  });

/** Rust answers `chunk_get` with a raw IPC response (ArrayBuffer); accept a byte array too for older builds. */
const toBytes = (raw: ArrayBuffer | Uint8Array | number[]) =>
  raw instanceof Uint8Array ? raw : new Uint8Array(raw);

function isNotFound(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'code' in e && e.code === 'NOT_FOUND';
}

/**
 * Pending chunks in the Rust encrypted disk store (AES-256-GCM, per-device keychain key; ADR-012 3.5) via
 * `chunk_put` / `chunk_get` / `chunk_delete` / `chunk_exists` / `chunk_list` / `chunk_tombstone`. Rust takes the
 * account from its own authenticated session (never from here), namespaces storage by a keyed hash of it, and binds
 * it into the AAD. Rust caps each chunk at the
 * upload body limit and fails closed when the keychain key is unavailable. Bytes and errors are never logged here.
 */
export function createNativeChunkStore(invoke: Invoke): ChunkStore {
  // Recordings being written in this launch: hidden from list() until their metadata exists.
  const writing = new Set<string>();
  return {
    put: async (id, seq, bytes) => {
      writing.add(id);
      await putRaw(invoke, id, seq, bytes);
    },
    read: async (id, seq) =>
      toBytes(await invoke<ArrayBuffer | number[]>('chunk_get', { sessionId: id, index: seq })),
    remove: async (id) => {
      await invoke('chunk_delete', { sessionId: id });
      writing.delete(id);
    },
    exists: (id) => invoke<boolean>('chunk_exists', { sessionId: id }),
    list: async () =>
      (await invoke<StoredRecording[]>('chunk_list')).filter((r) => !writing.has(r.id)),
    tombstone: async (id) => {
      await invoke('chunk_tombstone', { sessionId: id });
    },
    saveMeta: async (id, meta) => {
      await putRaw(invoke, id, META_INDEX, new TextEncoder().encode(meta));
      writing.delete(id);
    },
    readMeta: async (id) => {
      try {
        const raw = await invoke<ArrayBuffer | number[]>('chunk_get', {
          sessionId: id,
          index: META_INDEX,
        });
        return new TextDecoder().decode(toBytes(raw));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
  };
}
