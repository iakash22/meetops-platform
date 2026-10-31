/* global module, require */
/**
 * Native config for consent-first, visible recording (docs/mobile/plan.md "Platform configuration", R2, R4).
 * - iOS: `UIBackgroundModes: ["audio"]` so a user-started capture keeps running with the system mic indicator
 *   when the app is backgrounded. The app only enables the recording audio session while a capture is active.
 * - Android: notification permission (asked before capture on Android 13+), backups off (set in app.config.ts).
 *   NATIVE GAP: the microphone foreground service (FOREGROUND_SERVICE_MICROPHONE + a service with
 *   foregroundServiceType="microphone" and a Stop/Open notification) needs a native module; until it lands the app
 *   pauses capture when it leaves the foreground on Android, so it never records without a visible indicator, and
 *   the manifest does not declare a foreground service it doesn't have.
 */
const { AndroidConfig, withInfoPlist } = require('expo/config-plugins');

module.exports = function withRecordingCompliance(config) {
  config = withInfoPlist(config, (c) => {
    const modes = new Set(c.modResults.UIBackgroundModes || []);
    modes.add('audio');
    c.modResults.UIBackgroundModes = [...modes];
    return c;
  });
  return AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.RECORD_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
  ]);
};
