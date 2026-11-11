/* eslint-disable @typescript-eslint/no-require-imports -- lazy iOS-only native module (createIosLiveActivity) */
import { Platform } from 'react-native';

/**
 * iOS Live Activity / Dynamic Island for the recorder (plan.md R2). The recorder drives it: `start` once capture is
 * running, `pause`/`resume` as the user (or a call) pauses, `end` on Stop/abort, `endAll` at launch after a crash.
 * Calls are best effort: a user who turned Live Activities off still records with the system mic indicator and the
 * in-app banner, so a refused or failed activity never blocks or stops capture. Nothing sensitive is shown.
 *
 * `start` returns a native activity id (ActivityKit `activity.id`, or null when the system refuses). Callers of
 * this port — `createRecordingLiveActivity` — store that id and pass it to `update` / `end`. A missing or empty
 * id is fail-closed: no update or end is sent, so a refused start cannot touch some other activity.
 */
export interface LiveActivityPort {
  start(startedAtMs: number): Promise<string | null>;
  update(id: string, paused: boolean, startedAtMs: number, elapsedMs: number): Promise<void>;
  end(id: string): Promise<void>;
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

/** True for a non-empty activity id the native side issued. Empty / non-strings are fail-closed. */
export function isLiveActivityId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
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
 *
 * The id returned by `start` is stored and passed to later `update`/`end`. A late start that resolves after it
 * was superseded is ended by that id only — never `endAll`, so a newer recording's activity is left alone.
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
  /** Native id from the last successful `start`; cleared on end / endAll / a refused start. */
  let activityId: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  const timeoutMs = opts.callTimeoutMs ?? LIVE_ACTIVITY_CALL_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  /**
   * Resolves when `f` settles or after the timeout, whichever comes first; never rejects.
   * `onValue` runs (and is awaited) when `f` settles in time, still on the queue, so a start can store
   * its id — or end it — before the next queued call. `onLate` runs if `f` resolves only after the
   * timeout already moved the queue on; it must enqueue any follow-up work, never run it off-queue.
   */
  const bounded = (
    f: () => Promise<unknown>,
    onValue?: (value: unknown) => unknown,
    onLate?: (value: unknown) => void,
  ) =>
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
          if (done) {
            onLate?.(value);
            return;
          }
          Promise.resolve(onValue?.(value)).then(finish, finish);
        }, finish);
      } catch {
        // A synchronous native throw: best effort, move on.
        finish();
      }
    });
  const enqueue = (
    f: () => Promise<unknown>,
    onValue?: (value: unknown) => unknown,
    onLate?: (value: unknown) => void,
  ) => {
    queue = queue.then(() => bounded(f, onValue, onLate));
    return queue;
  };
  /**
   * Bumped only by start(). An in-flight start that completes after end() must still store its id so the
   * already-queued end() can use it. A start that completes after a *newer* start() must end its own id
   * and must not overwrite the new activityId.
   */
  let startSeq = 0;
  /** Sends an update only with a stored id and sane times; a bad clock or refused start never reaches native. */
  const update = (p: boolean, t: number, e: number) => {
    if (!isValidTimeMs(t) || !isValidTimeMs(e)) return;
    void enqueue(async () => {
      const id = activityId;
      if (!isLiveActivityId(id)) return;
      await port.update(id, p, t, e);
    });
  };

  return {
    start() {
      const myStart = ++startSeq;
      running = true;
      paused = false;
      startedAt = now();
      elapsedAtPause = 0;
      activityId = null;
      const t = startedAt;
      if (!isValidTimeMs(t)) {
        // No activity without a sane start time; capture itself is unaffected.
        running = false;
        return;
      }
      void enqueue(
        () => port.start(t),
        async (raw) => {
          const id = isLiveActivityId(raw) ? raw : null;
          // A newer start() replaced us: end this id and do not overwrite the new activityId.
          // end()/endAll() do not bump startSeq, so we still store the id for the queued end.
          if (myStart !== startSeq) {
            if (id) await port.end(id);
            return;
          }
          activityId = id;
        },
        (started) => {
          // The start timed out, so the queue moved on (maybe already ran end(), which had no id yet),
          // and then ActivityKit created the activity anyway. End that id only; never endAll(), so a
          // newer recording's activity is not torn down.
          const id = isLiveActivityId(started) ? started : null;
          if (!id) return;
          if (myStart === startSeq && running) {
            activityId = id;
            // An update queued during the timeout was fail-closed (no id yet): re-sync pause if needed.
            if (paused && isValidTimeMs(startedAt) && isValidTimeMs(elapsedAtPause)) {
              const [cur, e] = [startedAt, elapsedAtPause];
              void enqueue(() => port.update(id, true, cur, e));
            }
            return;
          }
          void enqueue(() => port.end(id));
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
      running = false;
      paused = false;
      void enqueue(async () => {
        const id = activityId;
        activityId = null;
        if (isLiveActivityId(id)) await port.end(id);
      });
    },
    async endAll() {
      running = false;
      paused = false;
      activityId = null;
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
    update: (id, p, t, e) => native.update(id, p, t, e),
    end: (id) => native.end(id),
    endAll: () => native.endAll(),
    onStopRequested(listener) {
      const sub = native.addListener('onStopRequested', listener);
      return () => sub.remove();
    },
  });
}
