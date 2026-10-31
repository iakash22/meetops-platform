import type { FileSystemLike } from './fileChunkStore';
import type { RecorderFileGuard } from './nativeCapture';

/** Extensions expo-audio's recorder writes (m4a on both platforms; others from older builds/presets). */
const RECORDER_EXT = /\.(m4a|aac|3gp|caf|wav|amr|webm|ts)$/i;
/** Our own encrypted store lives under documentDirectory, never in the cache, so the sweep can't touch it. */
const MAX_DEPTH = 2;

/**
 * Recorder output guard (see `RecorderFileGuard`). `protect` is the platform hook (iOS backup exclusion + file
 * protection; null = nothing extra needed, Android's app cache is private and FBE-encrypted). `sweep` deletes
 * recorder files left in the cache directory at launch, before any new recording starts.
 */
export function createRecorderFileGuard(
  fs: Pick<FileSystemLike, 'readDirectoryAsync' | 'deleteAsync' | 'getInfoAsync'>,
  cacheDirectory: string | null,
  protect: ((uri: string) => Promise<boolean>) | null,
): RecorderFileGuard {
  const scan = async (dir: string, depth: number): Promise<number> => {
    let names: string[];
    try {
      names = await fs.readDirectoryAsync(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const uri = `${dir.endsWith('/') ? dir : `${dir}/`}${name}`;
      if (RECORDER_EXT.test(name)) {
        await fs.deleteAsync(uri, { idempotent: true }).then(
          () => (removed += 1),
          () => undefined,
        );
      } else if (depth < MAX_DEPTH && !name.includes('.')) {
        removed += await scan(uri, depth + 1);
      }
    }
    return removed;
  };
  return {
    protect: async (uri) => {
      if (!protect) return true;
      try {
        return await protect(uri);
      } catch {
        return false; // fail closed
      }
    },
    sweep: () => (cacheDirectory ? scan(cacheDirectory, 0) : Promise.resolve(0)),
  };
}
