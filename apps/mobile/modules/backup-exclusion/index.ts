import { requireOptionalNativeModule } from 'expo';

/** iOS-only NSURLIsExcludedFromBackupKey setter (see ios/). Null on Android, in Jest and in Expo Go. */
interface BackupExclusionNative {
  /** Resolves true once the flag reads back as set. */
  exclude(fileUri: string): Promise<boolean>;
}

export const BackupExclusionModule =
  requireOptionalNativeModule<BackupExclusionNative>('BackupExclusion');
