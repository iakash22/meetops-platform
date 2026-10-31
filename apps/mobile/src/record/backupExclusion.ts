import type { FileSystemLike } from './fileChunkStore';

/**
 * R4 + R5 (iOS): wraps the file system so everything under `recordings/` is excluded from backup and file-protected.
 * - The `recordings/` folder is excluded before the first write of the run (and again whenever it's (re)created).
 * - Every new folder and every written file under it is excluded individually right after it's created; if that
 *   fails, the new file is deleted and the write rejects.
 * Fails closed: nothing is written under `recordings/` unless the folder flag is confirmed. Because the capture writes
 * its in-progress marker there in `begin`, a missing or failing module stops a recording at Start.
 */
export function withBackupExclusion(
  fs: FileSystemLike,
  exclude: (uri: string) => Promise<boolean>,
): FileSystemLike {
  const root = fs.documentDirectory ? `${fs.documentDirectory}recordings/` : null;
  let rootDone: Promise<void> | null = null;
  const must = async (uri: string) => {
    if (!(await exclude(uri))) throw new Error('Could not exclude recordings from backup.');
  };
  const ensureRoot = (): Promise<void> => {
    if (!root) return Promise.resolve();
    rootDone ??= (async () => {
      await fs.makeDirectoryAsync(root, { intermediates: true });
      await must(root);
    })().catch((e: unknown) => {
      rootDone = null;
      throw e;
    });
    return rootDone;
  };
  const inRoot = (uri: string) => root !== null && uri.startsWith(root);
  return {
    ...fs,
    documentDirectory: fs.documentDirectory,
    async makeDirectoryAsync(uri, options) {
      if (!inRoot(uri)) return fs.makeDirectoryAsync(uri, options);
      await ensureRoot();
      await fs.makeDirectoryAsync(uri, options);
      await must(uri);
    },
    async writeAsStringAsync(uri, contents, options) {
      if (!inRoot(uri)) return fs.writeAsStringAsync(uri, contents, options);
      await ensureRoot();
      await fs.writeAsStringAsync(uri, contents, options);
      try {
        await must(uri);
      } catch (e) {
        await fs.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
        throw e;
      }
    },
    async deleteAsync(uri, options) {
      await fs.deleteAsync(uri, options);
      // The folder itself was deleted (wipe): re-exclude it when it's next created.
      if (uri === root) rootDone = null;
    },
  };
}
