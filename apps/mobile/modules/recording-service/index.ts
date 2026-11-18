import { requireOptionalNativeModule } from 'expo';

interface EventSubscription {
  remove(): void;
}

/**
 * Android-only native module (see android/). Null on iOS, in Jest and in Expo Go.
 *
 * `start` returns the stable capture id (the same Long the service uses as EXTRA_CAPTURE_ID, as a decimal
 * string). Callers must store that id and pass it to `update` and `stop`. A mismatched or empty id is a
 * no-op (fail closed) and will not cancel a newer recording.
 */
export interface RecordingServiceNative {
  start(title: string, body: string): string;
  update(id: string, title: string, body: string): void;
  stop(id: string): void;
  isRunning(): boolean;
  /** Service in the foreground and its notification is showing (notifications enabled, channel not blocked). */
  isConfirmed(): boolean;
  addListener(event: 'onStopRequested' | 'onServiceLost', listener: () => void): EventSubscription;
}

export const RecordingServiceModule =
  requireOptionalNativeModule<RecordingServiceNative>('RecordingService');
