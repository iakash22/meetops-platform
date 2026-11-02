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

  it('without a seal signal the kill fallback still waits a fixed grace instead of firing at once', () => {
    const arm = service.slice(
      service.indexOf('fun armWatchdog('),
      service.indexOf('fun resetStopLatch'),
    );
    expect(arm).toContain('if (jsListening) JS_STOP_GRACE_MS else NATIVE_STOP_GRACE_MS');
    expect(arm).not.toMatch(/else 0L/);
  });

  it('both modules use the same seal-progress actions', () => {
    for (const a of ['SEALING', 'SEALED']) {
      const v = `ACTION_CAPTURE_${a} = "expo.modules.recordingservice.CAPTURE_${a}"`;
      expect(service).toContain(v);
      expect(recorder).toContain(v);
    }
  });

  it('a seal in flight holds the kill for at least 10 s, until the recorder reports SEALED', () => {
    const t = /NATIVE_SEAL_TIMEOUT_MS = ([\d_]+)L/.exec(service);
    expect(t).not.toBeNull();
    expect(Number((t?.[1] ?? '').replace(/_/g, ''))).toBeGreaterThanOrEqual(10_000);
    const sealing = service.slice(
      service.indexOf('fun onSealing()'),
      service.indexOf('fun onSealed()'),
    );
    expect(sealing).toContain('schedule(NATIVE_SEAL_TIMEOUT_MS)');
    // A seal already reported before the watchdog is armed keeps the long bound.
    expect(service).toContain('schedule(if (sealing) NATIVE_SEAL_TIMEOUT_MS');
    // Only SEALED may end the process at once.
    const sealed = service.slice(
      service.indexOf('fun onSealed()'),
      service.indexOf('fun listenForSeal('),
    );
    expect(sealed).toContain('else 0L');
    expect(sealed).toContain('if (watchdog == null) return');
  });

  it('the service listens for seal progress, not exported, before telling the recorder to stop', () => {
    const body = service.slice(service.indexOf('private fun nativeStop()'));
    expect(body.indexOf('listenForSeal(this)')).toBeGreaterThan(-1);
    expect(body.indexOf('listenForSeal(this)')).toBeLessThan(body.indexOf('sendBroadcast('));
    const listen = service.slice(service.indexOf('fun listenForSeal('));
    expect(listen.slice(0, 1200)).toContain('ContextCompat.RECEIVER_NOT_EXPORTED');
  });

  it('the recorder signals SEALING before sealing and SEALED after it, even on failure', () => {
    const body = recorder.slice(recorder.indexOf('private fun stopNatively()'));
    expect(body.indexOf('signal(ACTION_CAPTURE_SEALING)')).toBeLessThan(
      body.indexOf('shutdown(cur'),
    );
    const fin = body.slice(body.indexOf('} finally {'));
    expect(fin.slice(0, 200)).toContain('ns.done.countDown()');
    expect(fin.slice(0, 200)).toContain('signal(ACTION_CAPTURE_SEALED)');
    expect(recorder).toContain('Intent(action).setPackage(ctx.packageName)');
  });

  it('a failed stop-marker write is logged and propagated, not swallowed', () => {
    const body = recorder.slice(recorder.indexOf('private fun stopNatively()'));
    const write = body.slice(
      body.indexOf('ChunkSealer.writeDurably(File(cur.dir, STOPPED_SENTINEL)') - 200,
      body.indexOf('Thread({'),
    );
    expect(write).not.toMatch(/catch \(_: Exception\) \{\}/);
    expect(write).toContain('Log.e(TAG');
    expect(body).toContain('markerFailure?.let { throw it }');
    expect(body).toContain('ns.failure = t');
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
