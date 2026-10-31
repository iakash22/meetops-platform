import type { FileSystemLike } from '../../src/record/fileChunkStore';
import { base64ToBytes, bytesToBase64 } from '../../src/record/base64';

/** In-memory stand-in for expo-file-system's legacy API (files and directories by uri). */
export function createMemoryFs(): FileSystemLike & {
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  put(uri: string, bytes: Uint8Array): void;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const norm = (u: string) => (u.endsWith('/') ? u : `${u}/`);
  return {
    files,
    dirs,
    documentDirectory: 'file:///doc/',
    put: (uri, bytes) => void files.set(uri, bytes),
    getInfoAsync(uri) {
      const f = files.get(uri);
      if (f) return Promise.resolve({ exists: true, size: f.byteLength });
      const d = norm(uri);
      return Promise.resolve({
        exists: [...dirs, ...files.keys()].some((k) => k.startsWith(d)),
      });
    },
    makeDirectoryAsync(uri) {
      dirs.add(norm(uri));
      return Promise.resolve();
    },
    readAsStringAsync(uri, { encoding, position = 0, length }) {
      const f = files.get(uri);
      if (!f) return Promise.reject(new Error('ENOENT'));
      const slice = f.subarray(position, length === undefined ? undefined : position + length);
      return Promise.resolve(
        encoding === 'base64' ? bytesToBase64(slice) : new TextDecoder().decode(slice),
      );
    },
    writeAsStringAsync(uri, contents, { encoding }) {
      files.set(
        uri,
        encoding === 'base64' ? base64ToBytes(contents) : new TextEncoder().encode(contents),
      );
      return Promise.resolve();
    },
    deleteAsync(uri) {
      files.delete(uri);
      const d = norm(uri);
      for (const k of [...files.keys()]) if (k.startsWith(d)) files.delete(k);
      for (const k of [...dirs]) if (k.startsWith(d)) dirs.delete(k);
      return Promise.resolve();
    },
    readDirectoryAsync(uri) {
      const d = norm(uri);
      const names = new Set<string>();
      for (const k of [...files.keys(), ...dirs])
        if (k.startsWith(d) && k !== d) names.add(k.slice(d.length).split('/')[0]!);
      return Promise.resolve([...names]);
    },
  };
}

/** TEST ONLY: identity cipher so storage tests can read chunk bytes. The app has no plaintext cipher. */
export const testCipher = {
  seal: (b: string) => Promise.resolve(b),
  open: (b: string) => Promise.resolve(b),
};
