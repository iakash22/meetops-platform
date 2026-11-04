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

/** Longest a single queued native call may take before the queue moves on (a hung ActivityKit call). */
export const LIVE_ACTIVITY_CALL_TIMEOUT_MS = 5_000;

/** True for a time value the native side can turn into a Date / interval: finite and not negative. */
export function isValidTimeMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export interface RecordingLiveActivityOptions {
  /** Per-call timeout (default LIVE_ACTIVITY_CALL_TIMEOUT_MS). */
  callTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Native calls run strictly one after another (a promise queue): `start` is awaited before any `update` or `end`,
 * so a fast Start then Stop can't end "nothing" while the request is still in flight and leave an orphaned
 * activity on the lock screen. Failures are swallowed per call and never break the queue. Each call is also capped
 * at `callTimeoutMs`: a hung native start/update is abandoned so a later `end`/`endAll` still runs.
 */
export function createRecordingLiveActivity(
  port: LiveActivityPort,
  now: () => number = Date.now,
  opts: RecordingLiveActivityOptions = {},
): RecordingLiveActivity {
  let running = false;
  let paused = false;
  /** Effective start: wall clock minus elapsed, shifted on every resume so paused time doesn't count. */
  let startedAt = 0;
  let elapsedAtPause = 0;
  let queue: Promise<void> = Promise.resolve();
  const timeoutMs = opts.callTimeoutMs ?? LIVE_ACTIVITY_CALL_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  /**
   * Resolves when `f` settles or after the timeout, whichever comes first; never rejects. `onLate` runs if `f`
   * resolves only after the timeout already moved the queue on.
   */
  const bounded = (f: () => Promise<unknown>, onLate?: (value: unknown) => void) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimer(handle);
        resolve();
      };
      const handle = setTimer(finish, timeoutMs);
      try {
        Promise.resolve(f()).then((value) => {
          if (done) onLate?.(value);
          else finish();
        }, finish);
      } catch {
        // A synchronous native throw: best effort, move on.
        finish();
      }
    });
  const enqueue = (f: () => Promise<unknown>, onLate?: (value: unknown) => void) => {
    queue = queue.then(() => bounded(f, onLate));
    return queue;
  };
  /** Bumped by every start/end/endAll, so a late native start can tell whether it is still the current one. */
  let generation = 0;
  /** Sends an update only with sane times; a bad clock must never reach the native Date conversion. */
  const update = (p: boolean, t: number, e: number) => {
    if (!isValidTimeMs(t) || !isValidTimeMs(e)) return;
    void enqueue(() => port.update(p, t, e));
  };

  return {
    start() {
      const gen = ++generation;
      running = true;
      paused = false;
      startedAt = now();
      elapsedAtPause = 0;
      const t = startedAt;
      if (!isValidTimeMs(t)) {
        // No activity without a sane start time; capture itself is unaffected.
        running = false;
        return;
      }
      void enqueue(
        () => port.start(t),
        (started) => {
          // The start timed out, so the queue moved on (maybe already ran end()/endAll(), which found nothing),
          // and then ActivityKit created the activity anyway. Unless this is still the live recording, queue an
          // endAll() so it is not orphaned on the lock screen. A newer recording gets its activity back after it.
          if (started === false || gen === generation) return;
          void enqueue(() => port.endAll());
          if (running && isValidTimeMs(startedAt)) {
            const cur = startedAt;
            const p = paused;
            const e = elapsedAtPause;
            void enqueue(() => port.start(cur));
            if (p && isValidTimeMs(e)) void enqueue(() => port.update(true, cur, e));
          }
        },
      );
    },
    pause() {
      if (!running || paused) return;
      paused = true;
      elapsedAtPause = now() - startedAt;
      update(true, startedAt, elapsedAtPause);
    },
    resume() {
      if (!running || !paused) return;
      paused = false;
      startedAt = now() - elapsedAtPause;
      update(false, startedAt, elapsedAtPause);
    },
    end() {
      if (!running) return;
      generation++;
      running = false;
      paused = false;
      void enqueue(() => port.end());
    },
    async endAll() {
      generation++;
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
