/* eslint-disable @typescript-eslint/no-require-imports */
import { readFileSync } from 'fs';
import { join } from 'path';

import { createFileChunkStore } from '../src/record/fileChunkStore';
import {
  createRecordingLiveActivity,
  isLiveActivityId,
  isValidTimeMs,
  LIVE_ACTIVITY_CALL_TIMEOUT_MS,
  type LiveActivityPort,
  type RecordingLiveActivity,
} from '../src/record/liveActivity';
import { createNativeCapture, type AudioDriver } from '../src/record/nativeCapture';
import { createMemoryFs, testCipher } from './support/memoryFs';

function fakePort(over: Partial<LiveActivityPort> = {}) {
  const calls: unknown[][] = [];
  let stop: (() => void) | null = null;
  const port: LiveActivityPort = {
    start: (t) => (calls.push(['start', t]), Promise.resolve('act-1')),
    update: (id, p, t, e) => (calls.push(['update', id, p, t, e]), Promise.resolve()),
    end: (id) => (calls.push(['end', id]), Promise.resolve()),
    endAll: () => (calls.push(['endAll']), Promise.resolve(1)),
    onStopRequested(l) {
      stop = l;
      return () => {
        stop = null;
      };
    },
    ...over,
  };
  return { port, calls, tapStop: () => stop?.() };
}

function driver(): AudioDriver {
  let recording = false;
  return {
    canRecord: () => Promise.resolve(true),
    setRecordingMode: () => Promise.resolve(),
    prepare: () => Promise.resolve(),
    record: () => {
      recording = true;
    },
    pause: () => {
      recording = false;
    },
    stop: () => {
      recording = false;
      return Promise.resolve('file:///cache/ExpoAudio/rec.m4a');
    },
    isRecording: () => recording,
    currentUri: () => 'file:///cache/ExpoAudio/rec.m4a',
  };
}

describe('recording Live Activity state (R2)', () => {
  it('keeps elapsed time right across pause and resume', async () => {
    let t = 1_000;
    const { port, calls } = fakePort();
    const live = createRecordingLiveActivity(port, () => t);
    live.start();
    t = 11_000;
    live.pause();
    live.pause(); // repeated: no second update
    t = 61_000;
    live.resume();
    live.end();
    live.end();
    await live.settled();
    expect(calls).toEqual([
      ['start', 1_000],
      ['update', 'act-1', true, 1_000, 10_000],
      // Paused 50 s: the effective start moves forward by 50 s, elapsed stays 10 s.
      ['update', 'act-1', false, 51_000, 10_000],
      ['end', 'act-1'],
    ]);
  });

  it('is best effort: native failures (sync or async) never throw into the recorder', async () => {
    const live = createRecordingLiveActivity({
      start: () => Promise.reject(new Error('disabled')),
      update: () => {
        throw new Error('boom');
      },
      end: () => Promise.reject(new Error('x')),
      endAll: () => Promise.reject(new Error('x')),
      onStopRequested: () => {
        throw new Error('x');
      },
    });
    expect(() => {
      live.start();
      live.pause();
      live.resume();
      live.end();
    }).not.toThrow();
    await expect(live.endAll()).resolves.toBeUndefined();
    expect(typeof live.onStopRequested(() => undefined)).toBe('function');
  });

  it('ignores a Stop tap when nothing is recording', () => {
    const { port, tapStop } = fakePort();
    const live = createRecordingLiveActivity(port);
    const onStop = jest.fn();
    live.onStopRequested(onStop);
    tapStop();
    live.start();
    tapStop();
    live.end();
    tapStop();
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('Live Activity call serialization (hardening)', () => {
  function deferredPort() {
    const log: string[] = [];
    let releaseStart: (id: string | null) => void = () => undefined;
    const port: LiveActivityPort = {
      start: () => {
        log.push('start:begin');
        return new Promise<string | null>((r) => {
          releaseStart = (id) => {
            log.push('start:done');
            r(id);
          };
        });
      },
      update: async (id, p) => void log.push(`update:${id}:${p}`),
      end: async () => void log.push('end'),
      endAll: async () => (log.push('endAll'), 0),
      onStopRequested: () => () => undefined,
    };
    return { port, log, release: (id: string | null = 'act-1') => releaseStart(id) };
  }

  it('a fast Start then Stop ends only after the start request has finished (no orphan)', async () => {
    const d = deferredPort();
    const live = createRecordingLiveActivity(d.port);
    live.start();
    live.end();
    await Promise.resolve();
    expect(d.log).toEqual(['start:begin']); // end is waiting for start
    d.release();
    await live.settled();
    expect(d.log).toEqual(['start:begin', 'start:done', 'end']);
  });

  it('pause, resume and stop queue behind a slow start in call order', async () => {
    const d = deferredPort();
    const live = createRecordingLiveActivity(d.port);
    live.start();
    live.pause();
    live.resume();
    live.end();
    await Promise.resolve();
    d.release();
    await live.settled();
    expect(d.log).toEqual([
      'start:begin',
      'start:done',
      'update:act-1:true',
      'update:act-1:false',
      'end',
    ]);
  });

  it('launch endAll waits for an in-flight start, and a failing call never blocks the queue', async () => {
    const d = deferredPort();
    const failing = { ...d.port, update: () => Promise.reject(new Error('gone')) };
    const live = createRecordingLiveActivity(failing);
    live.start();
    live.pause();
    const all = live.endAll();
    await Promise.resolve();
    d.release(null);
    await all;
    expect(d.log).toEqual(['start:begin', 'start:done', 'endAll']);
  });
});

describe('native capture drives the Live Activity', () => {
  function setup() {
    const fake = fakePort();
    const live: RecordingLiveActivity = createRecordingLiveActivity(fake.port, () => 0);
    const fs = createMemoryFs();
    fs.put('file:///cache/ExpoAudio/rec.m4a', Uint8Array.from([1, 2, 3]));
    const capture = createNativeCapture(driver(), createFileChunkStore(fs, testCipher), null, {
      liveActivity: live,
    });
    return { ...fake, capture, live };
  }

  it('starts after capture begins, updates on pause/resume, ends on Stop', async () => {
    const { calls, capture, live } = setup();
    await capture.begin('rec-1');
    capture.pause();
    capture.resume();
    await capture.capture('rec-1', 1000);
    await live.settled();
    expect(calls.map((c) => c[0])).toEqual(['start', 'update', 'update', 'end']);
  });

  it('Stop on the Live Activity reaches the recorder only while recording', async () => {
    const { capture, tapStop } = setup();
    const onStop = jest.fn();
    const off = capture.onStopRequested!(onStop);
    tapStop();
    await capture.begin('rec-1');
    tapStop();
    expect(onStop).toHaveBeenCalledTimes(1);
    off();
  });

  it('abort ends it; launch recovery ends leftovers and never starts one', async () => {
    const { calls, capture } = setup();
    await capture.begin('rec-1');
    await capture.abort();
    await (capture as { recoverOnLaunch(): Promise<void> }).recoverOnLaunch();
    expect(calls.map((c) => c[0])).toEqual(['start', 'end', 'endAll']);
  });

  it('a failed begin never starts an activity', async () => {
    const fake = fakePort();
    const live = createRecordingLiveActivity(fake.port);
    const fs = createMemoryFs();
    const d = { ...driver(), canRecord: () => Promise.resolve(false) };
    const capture = createNativeCapture(d, createFileChunkStore(fs, testCipher), null, {
      liveActivity: live,
    });
    await expect(capture.begin('rec-1')).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

describe('Live Activity native config', () => {
  const root = join(__dirname, '..');
  const plugin = require('../plugins/withLiveActivity') as {
    TARGET: string;
    SWIFT_FILES: string[];
    setInfoPlist(p: Record<string, unknown>): Record<string, unknown>;
    addWidgetTarget(project: unknown, bundleId: string): boolean;
    findWidgetTarget(
      project: unknown,
    ): { productType: string; buildConfigurationList: string } | null;
  };

  it('the attributes type is identical in the app module and the widget extension', () => {
    const a = readFileSync(
      join(root, 'modules/live-activity/ios/RecordingActivityAttributes.swift'),
      'utf8',
    );
    const b = readFileSync(
      join(root, 'targets/RecordingLiveActivity/RecordingActivityAttributes.swift'),
      'utf8',
    );
    expect(a).toBe(b);
  });

  it('sets NSSupportsLiveActivities only (no frequent updates, no push)', () => {
    expect(plugin.setInfoPlist({})).toEqual({ NSSupportsLiveActivities: true });
  });

  it('adds one embedded WidgetKit extension target, idempotently', () => {
    // `xcode` is what expo/config-plugins edits the project with; any parseable pbxproj works as a base.
    const xcode = require(
      require.resolve('xcode', { paths: [require.resolve('expo/config-plugins')] }),
    ) as { project(p: string): XcodeProject };
    type XcodeProject = {
      parseSync(): XcodeProject;
      pbxXCBuildConfigurationSection(): Record<string, { buildSettings?: Record<string, string> }>;
      pbxXCConfigurationList(): Record<string, { buildConfigurations: { value: string }[] }>;
      hash: { project: { objects: Record<string, Record<string, { name?: string }>> } };
    };
    const base = join(
      require.resolve('react-native-screens/package.json'),
      '..',
      'ios/RNScreens.xcodeproj/project.pbxproj',
    );
    const project = xcode.project(base).parseSync();
    expect(plugin.addWidgetTarget(project, 'com.example.meetops')).toBe(true);
    expect(plugin.addWidgetTarget(project, 'com.example.meetops')).toBe(false);
    const target = plugin.findWidgetTarget(project)!;
    expect(target.productType).toBe('"com.apple.product-type.app-extension"');
    const list = project.pbxXCConfigurationList()[target.buildConfigurationList]!;
    const configs = project.pbxXCBuildConfigurationSection();
    for (const ref of list.buildConfigurations) {
      const s = configs[ref.value]!.buildSettings!;
      expect(s.PRODUCT_BUNDLE_IDENTIFIER).toBe('"com.example.meetops.RecordingLiveActivity"');
      expect(s.IPHONEOS_DEPLOYMENT_TARGET).toBe('16.2');
      expect(s.INFOPLIST_FILE).toBe('"RecordingLiveActivity/Info.plist"');
    }
    const copyPhases = Object.values(project.hash.project.objects.PBXCopyFilesBuildPhase ?? {});
    // Embedded in the app target's PlugIns folder (dstSubfolderSpec 13) and built before it.
    expect(
      copyPhases.some(
        (p) =>
          (p as { dstSubfolderSpec?: number }).dstSubfolderSpec === 13 && p.name === '"Copy Files"',
      ),
    ).toBe(true);
    expect(
      Object.keys(project.hash.project.objects.PBXTargetDependency ?? {}).length,
    ).toBeGreaterThan(0);
  });

  it('compiles the Stop intent into the app target too (App Intents metadata), idempotently', () => {
    const xcode = require(
      require.resolve('xcode', { paths: [require.resolve('expo/config-plugins')] }),
    ) as { project(p: string): { parseSync(): unknown } };
    const base = join(
      require.resolve('react-native-screens/package.json'),
      '..',
      'ios/RNScreens.xcodeproj/project.pbxproj',
    );
    const project = xcode.project(base).parseSync() as {
      getFirstTarget(): { uuid: string };
      addTarget(name: string, type: string, subfolder: string): { uuid: string };
      addBuildPhase(files: string[], type: string, comment: string, target: string): unknown;
      pbxSourcesBuildPhaseObj(t: string): { files: { comment?: string }[] };
    };
    const p = plugin as unknown as {
      addIntentToAppTarget(project: unknown, appName: string): boolean;
      findAppTarget(project: unknown, appName: string): { uuid: string };
      INTENT_FILE: string;
    };
    // RNScreens' first target is a static library: the intent must go to the app target, found by type + name.
    const app = project.addTarget('MeetOps', 'application', 'MeetOps');
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', app.uuid);
    expect(p.findAppTarget(project, 'MeetOps').uuid).toBe(app.uuid);
    expect(() => p.findAppTarget(project, 'RNScreens')).toThrow(/no application target/);
    expect(p.addIntentToAppTarget(project, 'MeetOps')).toBe(true);
    expect(p.addIntentToAppTarget(project, 'MeetOps')).toBe(false);
    const files = project.pbxSourcesBuildPhaseObj(app.uuid).files;
    expect(files.filter((f) => String(f.comment).includes(p.INTENT_FILE))).toHaveLength(1);
    const first = project.pbxSourcesBuildPhaseObj(project.getFirstTarget().uuid).files;
    expect(first.filter((f) => String(f.comment).includes(p.INTENT_FILE))).toHaveLength(0);
    expect(plugin.SWIFT_FILES).toContain(p.INTENT_FILE);
  });

  it('the intent is not in the pod, and the widget has a meetops://record deep-link fallback', () => {
    const pod = readFileSync(
      join(root, 'modules/live-activity/ios/RecordingActivityAttributes.swift'),
      'utf8',
    );
    expect(pod).not.toContain('LiveActivityIntent');
    const intent = readFileSync(
      join(root, 'targets/RecordingLiveActivity/StopRecordingIntent.swift'),
      'utf8',
    );
    expect(intent).toContain('LiveActivityIntent');
    // One shared constant: defined once per copy of the attributes file, used (never re-spelled) by the intent.
    expect(pod).toContain(
      'meetOpsStopRecordingNotification = Notification.Name("MeetOpsLiveActivityStopRecording")',
    );
    const widgetAttrs = readFileSync(
      join(root, 'targets/RecordingLiveActivity/RecordingActivityAttributes.swift'),
      'utf8',
    );
    expect(widgetAttrs).toContain(
      'meetOpsStopRecordingNotification = Notification.Name("MeetOpsLiveActivityStopRecording")',
    );
    // The intent keeps a file-private copy (no `import LiveActivity`); its spelling must match the shared constant.
    expect(intent).not.toContain('import LiveActivity');
    expect(intent).not.toContain('canImport(LiveActivity)');
    const spelling = (src: string, decl: RegExp) => src.match(decl)?.[1];
    const shared = spelling(
      pod,
      /meetOpsStopRecordingNotification = Notification\.Name\("([^"]+)"\)/,
    );
    const copy = spelling(
      intent,
      /fileprivate let stopRecordingIntentNotification = Notification\.Name\("([^"]+)"\)/,
    );
    expect(shared).toBe('MeetOpsLiveActivityStopRecording');
    expect(copy).toBe(shared);
    expect(
      spelling(widgetAttrs, /meetOpsStopRecordingNotification = Notification\.Name\("([^"]+)"\)/),
    ).toBe(shared);
    expect(intent).toContain('post(name: stopRecordingIntentNotification');
    expect(intent.match(/Notification\.Name\(/g)).toHaveLength(1);
    const mod = readFileSync(
      join(root, 'modules/live-activity/ios/LiveActivityModule.swift'),
      'utf8',
    );
    expect(mod).not.toContain('staleDate: nil');
    expect(mod.match(/staleDate: Self\.staleDate\(\)/g)).toHaveLength(2);
    // Native time validation mirrors isValidTimeMs: finite and >= 0, for start and for both update values.
    expect(mod).toContain('v.isFinite && v >= 0');
    expect(mod).toContain('guard Self.isValidTimeMs(startedAtMs) else { return nil }');
    expect(mod).toContain(
      'guard Self.isValidTimeMs(startedAtMs), Self.isValidTimeMs(elapsedMs) else { return }',
    );
    // start returns Activity.id (or nil); update/end target that id only.
    expect(mod).toContain('let activity = try Activity.request(');
    expect(mod).toContain('let id = activity.id');
    expect(mod).toContain('return id.isEmpty ? nil : id');
    expect(mod).toContain(
      'AsyncFunction("update") { (id: String, paused: Bool, startedAtMs: Double, elapsedMs: Double) async in',
    );
    expect(mod).toContain('AsyncFunction("end") { (id: String) async in');
    expect(mod).toContain('activity.id == id');
    expect(mod).toContain('guard Self.isActivityId(id) else { return }');
    expect(mod).not.toContain('return true');
    expect(mod).not.toContain('_ = try Activity.request');
    const podspec = readFileSync(
      join(root, 'modules/live-activity/ios/LiveActivity.podspec'),
      'utf8',
    );
    expect(podspec).toMatch(/s\.license\s*=\s*'UNLICENSED'/);
    const w = readFileSync(
      join(root, 'targets/RecordingLiveActivity/RecordingLiveActivityWidget.swift'),
      'utf8',
    );
    expect(w.match(/\.widgetURL\(recordURL\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(w).toContain('meetops://record');
  });

  it('lists the widget sources that exist on disk', () => {
    for (const f of [...plugin.SWIFT_FILES, 'Info.plist'])
      expect(readFileSync(join(root, 'targets', plugin.TARGET, f), 'utf8').length).toBeGreaterThan(
        0,
      );
  });

  it('the widget shows no meeting details and has a Stop action', () => {
    const w = readFileSync(
      join(root, 'targets/RecordingLiveActivity/RecordingLiveActivityWidget.swift'),
      'utf8',
    );
    expect(w).toContain('StopRecordingIntent()');
    expect(w).not.toMatch(/meetingTitle|meetingId|organizationId|context\.attributes\./);
  });
});

describe('Live Activity call timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const never = <T>() => new Promise<T>(() => undefined);

  it('a hung native start does not block end(): a late id is ended, not left orphaned', async () => {
    let lateStart: (id: string | null) => void = () => undefined;
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), new Promise<string | null>((r) => (lateStart = r))),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.end();
    await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS - 1);
    expect(calls).toEqual([['start', 1_000]]);
    await jest.advanceTimersByTimeAsync(1);
    await live.settled();
    // end ran, but start had not returned an id yet, so nothing was ended.
    expect(calls).toEqual([['start', 1_000]]);
    lateStart('act-1');
    await jest.advanceTimersByTimeAsync(0);
    await live.settled();
    expect(calls).toEqual([
      ['start', 1_000],
      ['end', 'act-1'],
    ]);
  });

  it('a hung update does not block endAll(), which still resolves', async () => {
    let t = 1_000;
    const { port, calls } = fakePort({
      update: (id, p, st, e) => (calls.push(['update', id, p, st, e]), never<void>()),
    });
    const live = createRecordingLiveActivity(port, () => t);
    live.start();
    t = 2_000;
    live.pause();
    const done = live.endAll();
    await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS);
    await done;
    expect(calls.at(-1)).toEqual(['endAll']);
  });

  it('a hung end() itself times out, so later calls still run', async () => {
    const { port, calls } = fakePort({ end: (id) => (calls.push(['end', id]), never<void>()) });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.end();
    const done = live.endAll();
    await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS);
    await done;
    expect(calls).toEqual([['start', 1_000], ['end', 'act-1'], ['endAll']]);
  });

  it('a start that resolves after its timeout and after end() is ended by that id (no orphan)', async () => {
    let lateStart: (id: string | null) => void = () => undefined;
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), new Promise<string | null>((r) => (lateStart = r))),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.end();
    await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS);
    await live.settled();
    // end() ran while the start was still in flight, so it ended nothing.
    expect(calls).toEqual([['start', 1_000]]);
    lateStart('act-late');
    await jest.advanceTimersByTimeAsync(0);
    await live.settled();
    expect(calls).toEqual([
      ['start', 1_000],
      ['end', 'act-late'],
    ]);
    expect(calls.filter((c) => c[0] === 'endAll')).toEqual([]);
  });

  it('a late start that reports no activity (null) queues nothing', async () => {
    let lateStart: (id: string | null) => void = () => undefined;
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), new Promise<string | null>((r) => (lateStart = r))),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.end();
    await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS);
    lateStart(null);
    await jest.advanceTimersByTimeAsync(0);
    await live.settled();
    expect(calls).toEqual([['start', 1_000]]);
  });

  it('a late start while the same recording is still live is left alone; a later end() ends it', async () => {
    let lateStart: (id: string | null) => void = () => undefined;
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), new Promise<string | null>((r) => (lateStart = r))),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS);
    lateStart('act-1');
    await jest.advanceTimersByTimeAsync(0);
    live.end();
    await live.settled();
    expect(calls).toEqual([
      ['start', 1_000],
      ['end', 'act-1'],
    ]);
  });

  it('honours a custom timeout and does not wait when calls settle quickly', async () => {
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), never<string | null>()),
    });
    const live = createRecordingLiveActivity(port, () => 1_000, { callTimeoutMs: 100 });
    live.start();
    live.end();
    await jest.advanceTimersByTimeAsync(100);
    await live.settled();
    // start never returned an id, so end is fail-closed (no port.end).
    expect(calls).toEqual([['start', 1_000]]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Live Activity time validation', () => {
  it('accepts only finite, non-negative numbers', () => {
    for (const ok of [0, 1, 1_700_000_000_000]) expect(isValidTimeMs(ok)).toBe(true);
    for (const bad of [-1, NaN, Infinity, -Infinity, '5', undefined, null])
      expect(isValidTimeMs(bad)).toBe(false);
  });

  it('never starts an activity with a bad start time', async () => {
    for (const bad of [NaN, -5, Infinity]) {
      const { port, calls } = fakePort();
      const live = createRecordingLiveActivity(port, () => bad);
      live.start();
      live.pause();
      live.end();
      await live.settled();
      expect(calls).toEqual([]);
    }
  });

  it('drops an update whose elapsed time is not finite and non-negative', async () => {
    const clock = [1_000, NaN];
    const { port, calls } = fakePort();
    const live = createRecordingLiveActivity(port, () => clock.shift() ?? 0);
    live.start(); // 1_000
    live.pause(); // elapsed NaN - 1_000 = NaN: dropped
    live.end();
    await live.settled();
    expect(calls).toEqual([
      ['start', 1_000],
      ['end', 'act-1'],
    ]);
  });

  it('drops an update with a negative elapsed time (clock went backwards)', async () => {
    const clock = [5_000, 4_000];
    const { port, calls } = fakePort();
    const live = createRecordingLiveActivity(port, () => clock.shift() ?? 0);
    live.start();
    live.pause();
    live.end();
    await live.settled();
    expect(calls).toEqual([
      ['start', 5_000],
      ['end', 'act-1'],
    ]);
  });
});

describe('Live Activity id contract', () => {
  it('accepts only a non-empty string as an activity id', () => {
    expect(isLiveActivityId('act-1')).toBe(true);
    expect(isLiveActivityId('0')).toBe(true);
    for (const bad of ['', true, false, 1, 0, null, undefined, {}, []]) {
      expect(isLiveActivityId(bad)).toBe(false);
    }
  });

  it('stores the id from start and passes it to update and end', async () => {
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), Promise.resolve('act-42')),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.pause();
    live.end();
    await live.settled();
    expect(calls).toEqual([
      ['start', 1_000],
      ['update', 'act-42', true, 1_000, 0],
      ['end', 'act-42'],
    ]);
  });

  it('fail-closes when start returns null: no update or end is sent', async () => {
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), Promise.resolve(null)),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.pause();
    live.resume();
    live.end();
    await live.settled();
    expect(calls).toEqual([['start', 1_000]]);
  });

  it('fail-closes when start returns an empty string', async () => {
    const { port, calls } = fakePort({
      start: (t) => (calls.push(['start', t]), Promise.resolve('')),
    });
    const live = createRecordingLiveActivity(port, () => 1_000);
    live.start();
    live.pause();
    live.end();
    await live.settled();
    expect(calls).toEqual([['start', 1_000]]);
  });

  it('a late start after a newer recording started ends only the late id, not the new one', async () => {
    jest.useFakeTimers();
    try {
      const late: Array<(id: string | null) => void> = [];
      let n = 0;
      const { port, calls } = fakePort({
        start: (t) => {
          const i = n++;
          calls.push(['start', t]);
          return new Promise<string | null>((r) => {
            late[i] = r;
          });
        },
      });
      let t = 1_000;
      const live = createRecordingLiveActivity(port, () => t);
      live.start(); // first start hangs
      await jest.advanceTimersByTimeAsync(LIVE_ACTIVITY_CALL_TIMEOUT_MS);
      t = 2_000;
      live.start(); // newer recording; first start is superseded
      await jest.advanceTimersByTimeAsync(0);
      late[1]!('act-new'); // current recording gets its id
      await jest.advanceTimersByTimeAsync(0);
      late[0]!('act-old'); // late first start must end only act-old
      await jest.advanceTimersByTimeAsync(0);
      await live.settled();
      expect(calls).toEqual([
        ['start', 1_000],
        ['start', 2_000],
        ['end', 'act-old'],
      ]);
      live.end();
      await live.settled();
      expect(calls).toEqual([
        ['start', 1_000],
        ['start', 2_000],
        ['end', 'act-old'],
        ['end', 'act-new'],
      ]);
      expect(calls.filter((c) => c[0] === 'endAll')).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
