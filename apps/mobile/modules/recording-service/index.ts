import { requireOptionalNativeModule } from 'expo';

interface EventSubscription {
  remove(): void;
}

/** Android-only native module (see android/). Null on iOS, in Jest and in Expo Go. */
interface RecordingServiceNative {
  start(title: string, body: string): void;
  stop(): void;
  isRunning(): boolean;
  /** Service in the foreground and its notification is showing (notifications enabled, channel not blocked). */
  isConfirmed(): boolean;
  addListener(event: 'onStopRequested' | 'onServiceLost', listener: () => void): EventSubscription;
}

export const RecordingServiceModule =
  requireOptionalNativeModule<RecordingServiceNative>('RecordingService');
