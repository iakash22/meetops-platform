import { Linking } from 'react-native';

/**
 * Microphone permission port (plan.md "Permission prompts"). The native implementation (expo-audio
 * `requestRecordingPermissionsAsync`, Android 13+ notification permission) lands with the recorder in M4, which needs
 * native deps. Until then the app uses `createDemoMicPermission`. Rules: never prompt at launch, always show the in-app
 * pre-prompt before the OS prompt, and never retry silently after a denial.
 */
export type MicPermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface MicPermission {
  status: () => Promise<MicPermissionStatus>;
  /** Shows the OS prompt. Only called after the in-app pre-prompt. */
  request: () => Promise<MicPermissionStatus>;
  openSettings: () => Promise<void>;
}

export function createDemoMicPermission(
  options: { initial?: MicPermissionStatus; onRequest?: MicPermissionStatus } = {},
): MicPermission & { requests: number } {
  let current: MicPermissionStatus = options.initial ?? 'undetermined';
  const api = {
    requests: 0,
    status: () => Promise.resolve(current),
    request: () => {
      api.requests += 1;
      current = options.onRequest ?? 'granted';
      return Promise.resolve(current);
    },
    openSettings: () => Linking.openSettings(),
  };
  return api;
}
