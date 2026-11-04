/* eslint-disable @typescript-eslint/no-require-imports -- lazy iOS-only native module (createIosLiveActivity) */
import { Platform } from 'react-native';

/**
 * iOS Live Activity / Dynamic Island for the recorder (plan.md R2). The recorder drives it: `start` once capture is
 * running, `pause`/`resume` as the user (or a call) pauses, `end` on Stop/abort, `endAll` at launch after a crash.
 * Calls are best effort: a user who turned Live Activities off still records with the system mic indicator and the
 * in-app banner, so a refused or failed activity never blocks or stops capture. Nothing sensitive is shown.
 */
export interface LiveActivityPort {
  start(startedAtMs: number): Promise<boolean>;
  update(paused: boolean, startedAtMs: number, elapsedMs: number): Promise<void>;
  end(): Promise<void>;
  endAll(): Promise<number>;
  onStopRequested(listener: () => void): () => void;
}

/** What the recorder calls. Tracks elapsed time across pauses so the widget timer stays right. */
export interface RecordingLiveActivity {
  start(): void;
  pause(): void;
  resume(): void;
  end(): void;
  endAll(): Promise<void>;
  onStopRequested(listener: () => void): () => void;
  /** Resolves once every queued native call has finished (tests, and anything that must wait for Stop). */
  settled(): Promise<void>;
}

/**
 * Native calls run strictly one after another (a promise queue): `start` is awaited before any `update` or `end`,
 * so a fast Start then Stop can't end "nothing" while the request is still in flight and leave an orphaned
 * activity on the lock screen. Failures are swallowed per call and never break the queue.
 */
export function createRecordingLiveActivity(
  port: LiveActivityPort,
  now: () => number = Date.now,
): RecordingLiveActivity {
  let running = false;
  let paused = false;
  /** Effective start: wall clock minus elapsed, shifted on every resume so paused time doesn't count. */
  let startedAt = 0;
  let elapsedAtPause = 0;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (f: () => Promise<unknown>) => {
    // `then` also catches a synchronous native throw; each step's failure is swallowed (best effort).
    queue = queue.then(f).then(
      () => undefined,
      () => undefined,
    );
    return queue;
  };

  return {
    start() {
      running = true;
      paused = false;
      startedAt = now();
      elapsedAtPause = 0;
      const t = startedAt;
      void enqueue(() => port.start(t));
    },
    pause() {
      if (!running || paused) return;
      paused = true;
      elapsedAtPause = now() - startedAt;
      const [t, e] = [startedAt, elapsedAtPause];
      void enqueue(() => port.update(true, t, e));
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      startedAt = now() - elapsedAtPause;
      const [t, e] = [startedAt, elapsedAtPause];
      void enqueue(() => port.update(false, t, e));
    },
    end() {
      if (!running) return;
      running = false;
      paused = false;
      void enqueue(() => port.end());
    },
    async endAll() {
      running = false;
      paused = false;
      // Queued too, so a launch cleanup never races a start that is still in flight.
      await enqueue(() => port.endAll());
    },
    settled: () => queue,
    onStopRequested(listener) {
      try {
        return port.onStopRequested(() => {
          if (running) listener();
        });
      } catch {
        return () => undefined;
      }
    },
  };
}

/** Live mode on iOS with the native module (modules/live-activity); null elsewhere (Android, Jest, Expo Go). */
export function createIosLiveActivity(): RecordingLiveActivity | null {
  if (Platform.OS !== 'ios') return null;
  const { LiveActivityModule } =
    require('../../modules/live-activity') as typeof import('../../modules/live-activity');
  if (!LiveActivityModule) return null;
  const native = LiveActivityModule;
  return createRecordingLiveActivity({
    start: (t) => native.start(t),
    update: (p, t, e) => native.update(p, t, e),
    end: () => native.end(),
    endAll: () => native.endAll(),
    onStopRequested(listener) {
      const sub = native.addListener('onStopRequested', listener);
      return () => sub.remove();
    },
  });
}
