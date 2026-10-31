import { Linking, PermissionsAndroid, Platform } from 'react-native';

import type { MicPermission, MicPermissionStatus } from '../consent/micPermission';
import type { AudioDriver } from './nativeCapture';
import type { ChunkCipher, FileSystemLike } from './fileChunkStore';

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
export function createNativeChunkCipher(): ChunkCipher & { deleteKey(): Promise<void> } {
  const { ChunkCryptoModule } =
    require('../../modules/chunk-crypto') as typeof import('../../modules/chunk-crypto');
  if (ChunkCryptoModule) {
    const native = ChunkCryptoModule;
    return {
      ready: async () => {
        // Round-trip once so a missing or broken key fails before the mic opens.
        const probe = 'AA==';
        if ((await native.open(await native.seal(probe))) !== probe)
          throw new Error('Encryption self-test failed.');
      },
      seal: (b) => native.seal(b),
      open: (b) => native.open(b),
      deleteKey: () => native.deleteKey(),
    };
  }
  const refuse = () =>
    Promise.reject(new Error('Encryption at rest is unavailable on this build.'));
  return { ready: refuse, seal: refuse, open: refuse, deleteKey: () => Promise.resolve() };
}
