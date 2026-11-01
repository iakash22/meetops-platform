import type { ChunkSource, LocalChunk } from '../upload/types';
import { base64ToBytes, bytesToBase64 } from './base64';
import { sha256Hex } from './sha256';

/**
 * On-device chunk files for recorded audio (R4, R5, R6).
 *
 * Layout: `<documentDirectory>recordings/<recordingId>/<seq>.chunk`. App sandbox only (never shared storage or the
 * photo library). Android: `allowBackup=false` keeps it out of Auto Backup. iOS: app files default to
 * `NSFileProtectionCompleteUntilFirstUserAuthentication`. NATIVE GAP (tracked in docs/mobile/plan.md): iOS
 * `isExcludedFromBackup` and Android Keystore AES-GCM need a small native module; expo-file-system 18 exposes neither.
 */
export const CHUNK_BYTES = 4 * 1024 * 1024;

/** The subset of expo-file-system's (legacy) API we use, injectable for tests. */
export interface FileSystemLike {
  documentDirectory: string | null;
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }>;
  makeDirectoryAsync(uri: string, options: { intermediates: boolean }): Promise<void>;
  readAsStringAsync(
    uri: string,
    options: { encoding: 'base64' | 'utf8'; position?: number; length?: number },
  ): Promise<string>;
  writeAsStringAsync(
    uri: string,
    contents: string,
    options: { encoding: 'base64' | 'utf8' },
  ): Promise<void>;
  deleteAsync(uri: string, options: { idempotent: boolean }): Promise<void>;
  readDirectoryAsync(uri: string): Promise<string[]>;
}

export interface FileChunkStore extends ChunkSource {
  /**
   * Splits a finished recording file into sealed, hashed chunk files, then deletes the source file. Crash-safe and
   * resumable: the source is deleted only after every chunk is written, so a kill or a failure mid-way keeps the
   * recording (the caller's in-progress marker says to resume at the next launch).
   */
  ingest(recordingId: string, sourceUri: string): Promise<LocalChunk[]>;
  /** Recording ids that have files on disk. */
  list(): Promise<string[]>;
  /** Deletes a file that isn't a chunk (an unfinished recorder output). */
  deleteFile(uri: string): Promise<void>;
  /** Rejects when chunks can't be encrypted (fail closed). */
  ready(): Promise<void>;
  /** Re-seals every plaintext chunk left by an older build. Returns how many were migrated. */
  migrateLegacy(): Promise<number>;
  /** Crash recovery marker: the recorder output uri of the capture in progress (null clears it). */
  setInProgress(uri: string | null): Promise<void>;
  getInProgress(): Promise<string | null>;
  /** Full crash recovery marker (phase `recording` or `sealing`). Null clears it. */
  setMarker(marker: CaptureMarker | null): Promise<void>;
  getMarker(): Promise<CaptureMarker | null>;
  /** Recording ids sealed by crash recovery that have no queue entry yet (kept, encrypted, until enqueued or wiped). */
  held(): Promise<string[]>;
  /** Folder (uri, trailing slash) a native writer puts `<seq>.chunk` files in for this recording. */
  chunkDir(recordingId: string): string;
  /** Records the chunk list of a recording written natively (same file `ingest` writes). */
  writeManifest(recordingId: string, chunks: LocalChunk[]): Promise<void>;
  /** Chunks written by a completed `ingest` (null when it never finished). */
  manifest(recordingId: string): Promise<LocalChunk[] | null>;
  setHeld(ids: string[]): Promise<void>;
}

/**
 * In-progress marker. `recording`: the recorder file is still open (an unfinalized m4a is unplayable, so a crash
 * discards it). `sealing`: Stop finalized the file and sealing started; a crash resumes sealing instead of deleting.
 * `draft` is the queue entry minus chunks (consent attestation etc.) when the caller supplied it.
 */
export interface CaptureMarker {
  uri: string;
  phase: 'recording' | 'sealing';
  recordingId?: string;
  attempts?: number;
  draft?: unknown;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Encryption at rest for chunk files (R5). Base64 in, base64 out. Android: AES-256-GCM with a Keystore key
 * (`modules/chunk-crypto`). iOS: AES-256-GCM with a Keychain key (CryptoKit). There is no plaintext cipher in the app. Hashes and sizes are
 * always over the plaintext, which is what the server checks.
 */
export interface ChunkCipher {
  seal(plainBase64: string): Promise<string>;
  open(sealedBase64: string): Promise<string>;
  /** Rejects when encryption can't work (no native module, no key). Capture checks it before the mic opens. */
  ready?(): Promise<void>;
  /**
   * Native, off the JS thread: reads `sourceUri` in `chunkBytes` slices, seals each into `<destDir><seq>.chunk` (same
   * MAGIC envelope) atomically (tmp + rename), and journals progress so a re-run after a kill resumes. Returns
   * plaintext sizes and sha256. Never deletes the source.
   */
  sealFile?(sourceUri: string, destDir: string, chunkBytes: number): Promise<LocalChunk[]>;
}

/**
 * Envelope on every chunk file: 8-byte magic "MOCHUNK1" then the cipher output. A file without it was written in
 * plaintext by a build before encryption at rest; it is re-sealed on launch (`migrateLegacy`) or on first read.
 */
const MAGIC = Uint8Array.from([0x4d, 0x4f, 0x43, 0x48, 0x55, 0x4e, 0x4b, 0x31]);
const hasMagic = (b: Uint8Array) => b.length >= MAGIC.length && MAGIC.every((v, i) => b[i] === v);
const wrap = (sealedB64: string) => {
  const body = base64ToBytes(sealedB64);
  const out = new Uint8Array(MAGIC.length + body.length);
  out.set(MAGIC);
  out.set(body, MAGIC.length);
  return bytesToBase64(out);
};

export function createFileChunkStore(
  fs: FileSystemLike,
  /** Required: there is no plaintext default (R5, fail closed). */
  cipher: ChunkCipher,
  chunkBytes = CHUNK_BYTES,
): FileChunkStore {
  const root = () => {
    if (!fs.documentDirectory) throw new Error('No app sandbox directory.');
    return `${fs.documentDirectory}recordings/`;
  };
  const dir = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error('Invalid recording id.');
    return `${root()}${id}/`;
  };
  const file = (id: string, seq: number) => `${dir(id)}${seq}.chunk`;

  const store: FileChunkStore = {
    async ingest(recordingId, sourceUri) {
      const info = await fs.getInfoAsync(sourceUri);
      if (!info.exists || !info.size) throw new Error('Recording file missing.');
      await fs.makeDirectoryAsync(dir(recordingId), { intermediates: true });
      let chunks: LocalChunk[];
      if (cipher.sealFile) {
        chunks = await cipher.sealFile(sourceUri, dir(recordingId), chunkBytes);
      } else {
        // JS fallback (tests / no native file sealer): idempotent, so a re-run simply rewrites every chunk.
        chunks = [];
        for (let seq = 0, pos = 0; pos < info.size; seq++, pos += chunkBytes) {
          const length = Math.min(chunkBytes, info.size - pos);
          const b64 = await fs.readAsStringAsync(sourceUri, {
            encoding: 'base64',
            position: pos,
            length,
          });
          const bytes = base64ToBytes(b64);
          await fs.writeAsStringAsync(file(recordingId, seq), wrap(await cipher.seal(b64)), {
            encoding: 'base64',
          });
          chunks.push({ seq, sizeBytes: bytes.byteLength, sha256: sha256Hex(bytes) });
        }
      }
      // Hashes survive a kill between here and the caller clearing its marker (the plaintext is gone after this).
      await fs.writeAsStringAsync(`${dir(recordingId)}manifest.json`, JSON.stringify(chunks), {
        encoding: 'utf8',
      });
      // Only now is the plaintext redundant. On any failure above it stays for the launch resume.
      await fs.deleteAsync(sourceUri, { idempotent: true });
      return chunks;
    },
    async read(recordingId, seq) {
      const uri = file(recordingId, seq);
      const raw = base64ToBytes(await fs.readAsStringAsync(uri, { encoding: 'base64' }));
      if (hasMagic(raw))
        return base64ToBytes(await cipher.open(bytesToBase64(raw.subarray(MAGIC.length))));
      // Legacy plaintext chunk: seal it in place first, so it never stays readable at rest.
      await fs.writeAsStringAsync(uri, wrap(await cipher.seal(bytesToBase64(raw))), {
        encoding: 'base64',
      });
      return raw;
    },
    ready: () => cipher.ready?.() ?? Promise.resolve(),
    async migrateLegacy() {
      let migrated = 0;
      const info = await fs.getInfoAsync(root());
      if (!info.exists) return 0;
      for (const id of (await fs.readDirectoryAsync(root())).filter((n) => SAFE_ID.test(n))) {
        for (const name of await fs.readDirectoryAsync(dir(id))) {
          if (!/^\d+\.chunk$/.test(name)) continue;
          const uri = `${dir(id)}${name}`;
          const raw = base64ToBytes(await fs.readAsStringAsync(uri, { encoding: 'base64' }));
          if (hasMagic(raw)) continue;
          await fs.writeAsStringAsync(uri, wrap(await cipher.seal(bytesToBase64(raw))), {
            encoding: 'base64',
          });
          migrated += 1;
        }
      }
      return migrated;
    },
    async remove(recordingId) {
      await fs.deleteAsync(dir(recordingId), { idempotent: true });
    },
    async exists(recordingId) {
      return (await fs.getInfoAsync(dir(recordingId))).exists;
    },
    async list() {
      const info = await fs.getInfoAsync(root());
      if (!info.exists) return [];
      return (await fs.readDirectoryAsync(root())).filter((n) => SAFE_ID.test(n));
    },
    deleteFile: (uri) => fs.deleteAsync(uri, { idempotent: true }),
    async setInProgress(uri) {
      await store.setMarker(uri === null ? null : { uri, phase: 'recording' });
    },
    async getInProgress() {
      return (await store.getMarker())?.uri ?? null;
    },
    async setMarker(marker) {
      const path = `${root()}in-progress.uri`;
      if (marker === null) return fs.deleteAsync(path, { idempotent: true });
      await fs.makeDirectoryAsync(root(), { intermediates: true });
      await fs.writeAsStringAsync(path, JSON.stringify(marker), { encoding: 'utf8' });
    },
    async getMarker() {
      const path = `${root()}in-progress.uri`;
      if (!(await fs.getInfoAsync(path)).exists) return null;
      const raw = (await fs.readAsStringAsync(path, { encoding: 'utf8' })).trim();
      if (!raw) return null;
      try {
        const m = JSON.parse(raw) as CaptureMarker;
        if (m && typeof m.uri === 'string' && (m.phase === 'recording' || m.phase === 'sealing'))
          return m;
        return null;
      } catch {
        // Older builds wrote the bare uri: that was always a still-recording file.
        return { uri: raw, phase: 'recording' };
      }
    },
    chunkDir: (recordingId) => dir(recordingId),
    async writeManifest(recordingId, chunks) {
      await fs.makeDirectoryAsync(dir(recordingId), { intermediates: true });
      await fs.writeAsStringAsync(`${dir(recordingId)}manifest.json`, JSON.stringify(chunks), {
        encoding: 'utf8',
      });
    },
    async manifest(recordingId) {
      const path = `${dir(recordingId)}manifest.json`;
      if (!(await fs.getInfoAsync(path)).exists) return null;
      try {
        const c = JSON.parse(
          await fs.readAsStringAsync(path, { encoding: 'utf8' }),
        ) as LocalChunk[];
        return Array.isArray(c) && c.length > 0 ? c : null;
      } catch {
        return null;
      }
    },
    async held() {
      const path = `${root()}held.json`;
      if (!(await fs.getInfoAsync(path)).exists) return [];
      try {
        const ids = JSON.parse(await fs.readAsStringAsync(path, { encoding: 'utf8' })) as unknown;
        return Array.isArray(ids)
          ? ids.filter((i): i is string => typeof i === 'string' && SAFE_ID.test(i))
          : [];
      } catch {
        return [];
      }
    },
    async setHeld(ids) {
      const path = `${root()}held.json`;
      if (ids.length === 0) return fs.deleteAsync(path, { idempotent: true });
      await fs.makeDirectoryAsync(root(), { intermediates: true });
      await fs.writeAsStringAsync(path, JSON.stringify(ids), { encoding: 'utf8' });
    },
  };
  return store;
}
