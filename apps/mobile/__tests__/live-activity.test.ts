/* eslint-disable @typescript-eslint/no-require-imports */
import { readFileSync } from 'fs';
import { join } from 'path';

import { createFileChunkStore } from '../src/record/fileChunkStore';
import {
  createRecordingLiveActivity,
  type LiveActivityPort,
  type RecordingLiveActivity,
} from '../src/record/liveActivity';
import { createNativeCapture, type AudioDriver } from '../src/record/nativeCapture';
import { createMemoryFs, testCipher } from './support/memoryFs';

function fakePort(over: Partial<LiveActivityPort> = {}) {
  const calls: unknown[][] = [];
  let stop: (() => void) | null = null;
  const port: LiveActivityPort = {
    start: (t) => (calls.push(['start', t]), Promise.resolve(true)),
    update: (p, t, e) => (calls.push(['update', p, t, e]), Promise.resolve()),
    end: () => (calls.push(['end']), Promise.resolve()),
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
  it('keeps elapsed time right across pause and resume', () => {
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
    expect(calls).toEqual([
      ['start', 1_000],
      ['update', true, 1_000, 10_000],
      // Paused 50 s: the effective start moves forward by 50 s, elapsed stays 10 s.
      ['update', false, 51_000, 10_000],
      ['end'],
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

describe('native capture drives the Live Activity', () => {
  function setup() {
    const fake = fakePort();
    const live: RecordingLiveActivity = createRecordingLiveActivity(fake.port, () => 0);
    const fs = createMemoryFs();
    fs.put('file:///cache/ExpoAudio/rec.m4a', Uint8Array.from([1, 2, 3]));
    const capture = createNativeCapture(driver(), createFileChunkStore(fs, testCipher), null, {
      liveActivity: live,
    });
    return { ...fake, capture };
  }

  it('starts after capture begins, updates on pause/resume, ends on Stop', async () => {
    const { calls, capture } = setup();
    await capture.begin('rec-1');
    capture.pause();
    capture.resume();
    await capture.capture('rec-1', 1000);
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
