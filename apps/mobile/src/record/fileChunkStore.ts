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
  /** Splits a finished recording file into hashed chunk files, then deletes the source file. */
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

  return {
    async ingest(recordingId, sourceUri) {
      const info = await fs.getInfoAsync(sourceUri);
      if (!info.exists || !info.size) throw new Error('Recording file missing.');
      await fs.makeDirectoryAsync(dir(recordingId), { intermediates: true });
      const chunks: LocalChunk[] = [];
      try {
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
      } catch (e) {
        await fs.deleteAsync(dir(recordingId), { idempotent: true });
        throw e;
      } finally {
        await fs.deleteAsync(sourceUri, { idempotent: true });
      }
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
      const marker = `${root()}in-progress.uri`;
      if (uri === null) return fs.deleteAsync(marker, { idempotent: true });
      await fs.makeDirectoryAsync(root(), { intermediates: true });
      await fs.writeAsStringAsync(marker, uri, { encoding: 'utf8' });
    },
    async getInProgress() {
      const marker = `${root()}in-progress.uri`;
      if (!(await fs.getInfoAsync(marker)).exists) return null;
      return (await fs.readAsStringAsync(marker, { encoding: 'utf8' })) || null;
    },
  };
}
