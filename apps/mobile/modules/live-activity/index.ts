import { requireOptionalNativeModule } from 'expo';

interface EventSubscription {
  remove(): void;
}

/**
 * iOS-only ActivityKit bridge (see ios/). Null on Android, in Jest, in Expo Go and on builds without the module.
 * Times are epoch milliseconds. Nothing here carries audio, titles, meeting ids or tokens.
 */
interface LiveActivityNative {
  /** Live Activities are supported (iOS 16.2+) and enabled by the user in Settings. */
  areEnabled(): boolean;
  /** Starts the "Recording" activity; resolves false when the system refuses (disabled, budget, too old). */
  start(startedAtMs: number): Promise<boolean>;
  /** Running: elapsed counts from `startedAtMs`. Paused: shows `elapsedMs` frozen with a "Paused" label. */
  update(paused: boolean, startedAtMs: number, elapsedMs: number): Promise<void>;
  /** Ends the current activity immediately (dismissal policy .immediate). */
  end(): Promise<void>;
  /** Ends every MeetOps recording activity left by a crash or kill. Resolves the number ended. */
  endAll(): Promise<number>;
  /** The Stop button on the Live Activity / Dynamic Island (iOS 17+ App Intent) was tapped. */
  addListener(event: 'onStopRequested', listener: () => void): EventSubscription;
}

function load(): LiveActivityNative | null {
  try {
    return requireOptionalNativeModule<LiveActivityNative>('LiveActivity');
  } catch {
    return null;
  }
}

export const LiveActivityModule = load();
