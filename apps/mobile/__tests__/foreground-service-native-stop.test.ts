import { readFileSync } from 'fs';
import { join } from 'path';

// No Android SDK on the box: these source guards pin the native-Stop contract until the device check.
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const service = read(
  'modules/recording-service/android/src/main/java/expo/modules/recordingservice/RecordingForegroundService.kt',
);
const recorder = read(
  'modules/chunk-crypto/android/src/main/java/expo/modules/chunkcrypto/SegmentRecorderModule.kt',
);
const ACTION = '"expo.modules.recordingservice.CAPTURE_STOP"';

describe('native Stop without JS (swipe-away / notification Stop)', () => {
  it('both modules use the same broadcast action', () => {
    expect(service).toContain(`ACTION_CAPTURE_STOP = ${ACTION}`);
    expect(recorder).toContain(`ACTION_CAPTURE_STOP = ${ACTION}`);
  });

  it('the service tells the recorder directly, package-local, before arming the watchdog', () => {
    const body = service.slice(service.indexOf('private fun nativeStop()'));
    const send = body.indexOf('sendBroadcast(Intent(ACTION_CAPTURE_STOP).setPackage(packageName))');
    expect(send).toBeGreaterThan(-1);
    expect(send).toBeLessThan(body.indexOf('armWatchdog('));
  });

  it('swipe-away goes through the native stop', () => {
    const removed = service.slice(service.indexOf('override fun onTaskRemoved'));
    expect(removed.slice(0, 300)).toContain('nativeStop()');
  });

  it('without JS the kill fallback waits for the native seal instead of firing at once', () => {
    expect(service).toContain('if (jsListening) JS_STOP_GRACE_MS else NATIVE_STOP_GRACE_MS');
    expect(service).not.toMatch(/JS_STOP_GRACE_MS else 0L/);
  });

  it('the recorder receiver is not exported', () => {
    expect(recorder).toContain('ContextCompat.RECEIVER_NOT_EXPORTED');
  });

  it('the sentinel is written before sealing, so a kill mid-seal still keeps the recording', () => {
    const body = recorder.slice(recorder.indexOf('private fun stopNatively()'));
    const sentinel = body.indexOf('STOPPED_SENTINEL');
    expect(sentinel).toBeGreaterThan(-1);
    expect(sentinel).toBeLessThan(body.indexOf('shutdown(cur'));
  });

  it('a JS stop() after a native Stop waits for it and returns its chunks', () => {
    const stop = recorder.slice(recorder.indexOf('AsyncFunction("stop")'));
    expect(stop.slice(0, 900)).toContain('ns.done.await(');
    expect(stop.slice(0, 900)).toContain('chunks(ns.dir)');
  });

  it('exposes stoppedNatively for launch recovery', () => {
    expect(recorder).toContain('Function("stoppedNatively")');
  });
});
