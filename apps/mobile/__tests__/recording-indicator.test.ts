import {
  bindRecordingServiceIndicator,
  PAUSED_NOTIFICATION_TITLE,
  RECORDING_NOTIFICATION_BODY,
  RECORDING_NOTIFICATION_TITLE,
} from '../src/record/recordingIndicator';
import type { RecordingServiceNative } from '../modules/recording-service';

function fakeNative(over: Partial<RecordingServiceNative> = {}) {
  const calls: unknown[][] = [];
  const native: RecordingServiceNative = {
    start: (title, body) => (calls.push(['start', title, body]), '7'),
    update: (id, title, body) => void calls.push(['update', id, title, body]),
    stop: (id) => void calls.push(['stop', id]),
    isRunning: () => true,
    isConfirmed: () => true,
    addListener: (event, listener) => {
      calls.push(['listen', event]);
      return { remove: () => void calls.push(['remove', event, listener]) };
    },
    ...over,
  };
  return { native, calls };
}

describe('bindRecordingServiceIndicator', () => {
  it('returns the native capture id from start and passes it to update and stop', () => {
    const { native, calls } = fakeNative();
    const indicator = bindRecordingServiceIndicator(native);
    expect(indicator.start()).toBe('7');
    indicator.update('7', PAUSED_NOTIFICATION_TITLE, RECORDING_NOTIFICATION_BODY);
    indicator.stop('7');
    expect(calls).toEqual([
      ['start', RECORDING_NOTIFICATION_TITLE, RECORDING_NOTIFICATION_BODY],
      ['update', '7', PAUSED_NOTIFICATION_TITLE, RECORDING_NOTIFICATION_BODY],
      ['stop', '7'],
    ]);
  });

  it('fail-closes when start returns an empty id: no update or stop is sent', () => {
    const { native, calls } = fakeNative({
      start: (title, body) => (calls.push(['start', title, body]), ''),
    });
    const indicator = bindRecordingServiceIndicator(native);
    expect(indicator.start()).toBeNull();
    indicator.update('', 'x', 'y');
    indicator.stop('');
    expect(calls).toEqual([['start', RECORDING_NOTIFICATION_TITLE, RECORDING_NOTIFICATION_BODY]]);
  });

  it('update and stop with a missing id are no-ops (fail closed)', () => {
    const { native, calls } = fakeNative();
    const indicator = bindRecordingServiceIndicator(native);
    indicator.update('', 'x', 'y');
    indicator.stop('');
    expect(calls).toEqual([]);
  });
});
