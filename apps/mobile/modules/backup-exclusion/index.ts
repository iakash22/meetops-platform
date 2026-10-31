import { requireOptionalNativeModule } from 'expo';

/** iOS-only NSURLIsExcludedFromBackupKey setter (see ios/). Null on Android, in Jest and in Expo Go. */
interface BackupExclusionNative {
  /** Sets backup exclusion + CompleteUntilFirstUserAuthentication; true only when both read back as set. */
  exclude(fileUri: string): Promise<boolean>;
}

function load(): BackupExclusionNative | null {
  try {
    return requireOptionalNativeModule<BackupExclusionNative>('BackupExclusion');
  } catch {
    // Some runtimes (jest-expo) throw instead of returning null; both mean "not available" (fail closed upstream).
    return null;
  }
}

export const BackupExclusionModule = load();
