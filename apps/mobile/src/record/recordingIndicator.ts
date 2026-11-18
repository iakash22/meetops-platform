import type { RecordingServiceNative } from '../../modules/recording-service';
import { isLiveActivityId } from './liveActivity';
import type { ForegroundIndicator } from './nativeCapture';

export const RECORDING_NOTIFICATION_TITLE = 'MeetOps is recording';
export const PAUSED_NOTIFICATION_TITLE = 'MeetOps is paused';
export const RECORDING_NOTIFICATION_BODY = 'Tap Stop to end the recording now.';

/**
 * JS binder for the Android recording foreground service. `start` returns the native capture id (or null
 * if the module handed back an empty value). `update` / `stop` pass that id back and no-op without one,
 * so a refused start cannot touch a later session.
 */
export function bindRecordingServiceIndicator(native: RecordingServiceNative): ForegroundIndicator {
  return {
    start() {
      const id = native.start(RECORDING_NOTIFICATION_TITLE, RECORDING_NOTIFICATION_BODY);
      return isLiveActivityId(id) ? id : null;
    },
    update(id, title, body) {
      if (!isLiveActivityId(id)) return;
      native.update(id, title, body);
    },
    stop(id) {
      if (!isLiveActivityId(id)) return;
      native.stop(id);
    },
    isConfirmed: () => native.isConfirmed(),
    onStopRequested(listener) {
      // Notification Stop, and the service dying on its own: both end capture immediately.
      // Native fires exactly one of these per capture (latched in the service).
      const subs = [
        native.addListener('onStopRequested', listener),
        native.addListener('onServiceLost', listener),
      ];
      return () => subs.forEach((s) => s.remove());
    },
  };
}
