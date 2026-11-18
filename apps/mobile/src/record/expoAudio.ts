import { Linking, PermissionsAndroid, Platform } from 'react-native';

import type { MicPermission, MicPermissionStatus } from '../consent/micPermission';
import type { AudioDriver, ForegroundIndicator, RecorderFileGuard } from './nativeCapture';
import { bindRecordingServiceIndicator } from './recordingIndicator';
import { createRecorderFileGuard } from './recorderFiles';
import type { SegmentRecorder } from './segmentCapture';
import type { ChunkCipher, FileSystemLike } from './fileChunkStore';
import type { ChunkCryptoNative, ChunkKeyInfo } from '../../modules/chunk-crypto';

/**
 * expo-audio / expo-file-system bindings. Required lazily so Jest and demo mode never load the native modules.
 * Only `src/services.ts` calls these, and only in live mode.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
type ExpoAudio = typeof import('expo-audio');
const audio = (): ExpoAudio => require('expo-audio') as ExpoAudio;

const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS' as const;
const ANDROID_NEEDS_NOTIFICATIONS = Platform.OS === 'android' && Number(Platform.Version) >= 33;

const toStatus = (p: { granted: boolean; canAskAgain: boolean }): MicPermissionStatus =>
  p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';

/**
 * Plan "Permission prompts": the OS prompt only follows the in-app pre-prompt; Android 13+ also needs the
 * notification permission for the microphone foreground service notification, and without it recording doesn't
 * start. A denial is final until the user changes it in Settings.
 */
export function createNativeMicPermission(): MicPermission {
  const notifications = async (ask: boolean): Promise<MicPermissionStatus> => {
    if (!ANDROID_NEEDS_NOTIFICATIONS) return 'granted';
    const perm = POST_NOTIFICATIONS;
    if (await PermissionsAndroid.check(perm)) return 'granted';
    if (!ask) return 'undetermined';
    const r = await PermissionsAndroid.request(perm);
    return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
  };
  return {
    async status() {
      const mic = toStatus(await audio().getRecordingPermissionsAsync());
      if (mic !== 'granted') return mic;
      return notifications(false);
    },
    async request() {
      const mic = toStatus(await audio().requestRecordingPermissionsAsync());
      if (mic !== 'granted') return 'denied';
      return notifications(true);
    },
    openSettings: () => Linking.openSettings(),
  };
}

export function createExpoAudioDriver(): AudioDriver {
  const a = audio();
  let recorder: InstanceType<ExpoAudio['AudioModule']['AudioRecorder']> | null = null;
  const make = () =>
    (recorder ??= new a.AudioModule.AudioRecorder({
      ...a.RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: false,
    }));
  return {
    async canRecord() {
      const mic = await a.getRecordingPermissionsAsync();
      if (!mic.granted) return false;
      if (!ANDROID_NEEDS_NOTIFICATIONS) return true;
      return PermissionsAndroid.check(POST_NOTIFICATIONS);
    },
    setRecordingMode: (active) =>
      a.setAudioModeAsync({
        allowsRecording: active,
        playsInSilentMode: active,
        // iOS: UIBackgroundModes audio keeps a user-started capture alive with the system mic indicator.
        shouldPlayInBackground: active,
        interruptionMode: 'doNotMix',
      }),
    prepare: () => make().prepareToRecordAsync(),
    record: () => make().record(),
    pause: () => recorder?.pause(),
    async stop() {
      if (!recorder) return null;
      await recorder.stop();
      const uri = recorder.uri;
      recorder = null;
      return uri;
    },
    isRecording: () => recorder?.getStatus().isRecording ?? false,
    currentUri: () => recorder?.uri ?? null,
  };
}

export function expoFileSystem(): FileSystemLike {
  return require('expo-file-system') as FileSystemLike;
}

/**
 * Native AES-256-GCM for chunk files (modules/chunk-crypto): Android Keystore, iOS Keychain + CryptoKit.
 * FAIL CLOSED: without the native module this returns a cipher that rejects every call, so recording refuses to start
 * and nothing is ever written in plaintext.
 */
export type NativeChunkCipher = ChunkCipher & {
  deleteKey(): Promise<void>;
  /** Where the key lives (Android Keystore level); null when the build can't tell (iOS, older native builds). */
  keyInfo(): Promise<ChunkKeyInfo | null>;
};

export interface NativeChunkCipherOptions {
  /** Release build? Defaults to `!__DEV__`. */
  release?: boolean;
  /** Where the software-only Keystore warning goes. Defaults to console.warn. */
  warn?: (message: string, info: ChunkKeyInfo) => void;
}

export const SOFTWARE_KEY_WARNING =
  'Recording key is software-only (no TEE/StrongBox): encryption at rest is weaker on this device.';

/**
 * Release builds warn (and log) when the Keystore key is software-only, but still record: refusing would leave
 * emulators and older devices unable to record at all, and the key is still never exported (ADR-015).
 * Never throws: a keyInfo() failure must not block recording.
 */
async function warnIfSoftwareKey(
  native: ChunkCryptoNative,
  release: boolean,
  warn: (message: string, info: ChunkKeyInfo) => void,
): Promise<void> {
  if (!release || !native.keyInfo) return;
  let info: ChunkKeyInfo;
  try {
    info = await native.keyInfo();
  } catch {
    return;
  }
  if (info.securityLevel === 'software') warn(SOFTWARE_KEY_WARNING, info);
}

export function createNativeChunkCipher(
  native: ChunkCryptoNative | null = (
    require('../../modules/chunk-crypto') as typeof import('../../modules/chunk-crypto')
  ).ChunkCryptoModule,
  options: NativeChunkCipherOptions = {},
): NativeChunkCipher {
  const release = options.release ?? !(typeof __DEV__ !== 'undefined' && __DEV__);
  const warn =
    options.warn ??
    ((message: string, info: ChunkKeyInfo) =>
      console.warn(`[chunk-crypto] ${message}`, {
        alias: info.alias,
        securityLevel: info.securityLevel,
      }));
  if (native) {
    let checked = false;
    return {
      ready: async () => {
        // Round-trip once so a missing or broken key fails before the mic opens.
        const probe = 'AA==';
        if ((await native.open(await native.seal(probe))) !== probe)
          throw new Error('Encryption self-test failed.');
        if (!checked) {
          checked = true;
          await warnIfSoftwareKey(native, release, warn);
        }
      },
      seal: (b) => native.seal(b),
      open: (b) => native.open(b),
      // Off the JS thread and crash-safe (see modules/chunk-crypto). Older native builds: per-chunk JS path.
      ...(native.sealFile
        ? { sealFile: (src: string, dest: string, n: number) => native.sealFile!(src, dest, n) }
        : {}),
      deleteKey: () => native.deleteKey(),
      keyInfo: () => (native.keyInfo ? native.keyInfo() : Promise.resolve(null)),
    };
  }
  const refuse = () =>
    Promise.reject(new Error('Encryption at rest is unavailable on this build.'));
  return {
    ready: refuse,
    seal: refuse,
    open: refuse,
    deleteKey: () => Promise.resolve(),
    keyInfo: () => Promise.resolve(null),
  };
}

/** Android microphone foreground service (modules/recording-service). Null on iOS or without the native module. */
export function createAndroidForegroundIndicator(): ForegroundIndicator | null {
  if (Platform.OS !== 'android') return null;
  const { RecordingServiceModule } =
    require('../../modules/recording-service') as typeof import('../../modules/recording-service');
  if (!RecordingServiceModule) return null;
  return bindRecordingServiceIndicator(RecordingServiceModule);
}

/**
 * iOS backup exclusion + file protection for the recordings folder (modules/backup-exclusion). Null on Android.
 * FAIL CLOSED: on iOS without the native module it reports failure, so `withBackupExclusion` blocks every write.
 */
export function iosBackupExclusion(): ((uri: string) => Promise<boolean>) | null {
  if (Platform.OS !== 'ios') return null;
  const { BackupExclusionModule } =
    require('../../modules/backup-exclusion') as typeof import('../../modules/backup-exclusion');
  if (!BackupExclusionModule) return () => Promise.resolve(false);
  return (uri) => BackupExclusionModule.exclude(uri);
}

/** Recorder output guard for live mode: iOS protects the file after prepare (fail closed); both sweep the cache. */
export function recorderFileGuard(): RecorderFileGuard {
  const fs = require('expo-file-system') as FileSystemLike & { cacheDirectory: string | null };
  return createRecorderFileGuard(fs, fs.cacheDirectory, iosBackupExclusion());
}

/**
 * Android segment recorder (ADR-015, modules/chunk-crypto SegmentRecorderModule.kt). Null on iOS or on a build
 * without it, in which case capture stays on expo-audio + native sealFile.
 */
export function androidSegmentRecorder(): SegmentRecorder | null {
  if (Platform.OS !== 'android') return null;
  const { SegmentRecorderModule } =
    require('../../modules/chunk-crypto') as typeof import('../../modules/chunk-crypto');
  return SegmentRecorderModule ?? null;
}
