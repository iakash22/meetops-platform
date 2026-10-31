import { requireOptionalNativeModule } from 'expo';

interface EventSubscription {
  remove(): void;
}

/** Android-only native module (see android/). Null on iOS, in Jest and in Expo Go. */
interface RecordingServiceNative {
  start(title: string, body: string): void;
  stop(): void;
  isRunning(): boolean;
  addListener(event: 'onStopRequested', listener: () => void): EventSubscription;
}

export const RecordingServiceModule =
  requireOptionalNativeModule<RecordingServiceNative>('RecordingService');
