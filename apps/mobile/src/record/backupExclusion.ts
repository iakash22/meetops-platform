import type { FileSystemLike } from './fileChunkStore';

/**
 * R4 (iOS): wraps the file system so the `recordings/` folder is marked NSURLIsExcludedFromBackupKey before any
 * chunk or queue file is written into it. Fails closed: if the flag can't be set, the write never happens.
 * The flag on the folder covers everything inside it. It's re-checked once per app run.
 */
export function withBackupExclusion(
  fs: FileSystemLike,
  exclude: (uri: string) => Promise<boolean>,
): FileSystemLike {
  const root = fs.documentDirectory ? `${fs.documentDirectory}recordings/` : null;
  let done: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    if (!root) return Promise.resolve();
    done ??= (async () => {
      await fs.makeDirectoryAsync(root, { intermediates: true });
      if (!(await exclude(root))) throw new Error('Could not exclude recordings from backup.');
    })().catch((e: unknown) => {
      done = null;
      throw e;
    });
    return done;
  };
  const inRoot = (uri: string) => root !== null && uri.startsWith(root);
  return {
    ...fs,
    documentDirectory: fs.documentDirectory,
    async makeDirectoryAsync(uri, options) {
      if (inRoot(uri)) await ensure();
      return fs.makeDirectoryAsync(uri, options);
    },
    async writeAsStringAsync(uri, contents, options) {
      if (inRoot(uri)) await ensure();
      return fs.writeAsStringAsync(uri, contents, options);
    },
  };
}
