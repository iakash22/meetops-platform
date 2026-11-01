/* global module, require */
/**
 * Native config for consent-first, visible recording (docs/mobile/plan.md "Platform configuration", R2, R4).
 * - iOS: `UIBackgroundModes: ["audio"]` so a user-started capture keeps running with the system mic indicator
 *   when the app is backgrounded. The app only enables the recording audio session while a capture is active.
 * - Android: RECORD_AUDIO, POST_NOTIFICATIONS (asked before capture on Android 13+), and the microphone foreground
 *   service from `modules/recording-service` (ongoing notification with Stop and Open), declared with
 *   foregroundServiceType="microphone" and not exported. Backups are off (app.config.ts).
 */
const { AndroidConfig, withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const SERVICE = 'expo.modules.recordingservice.RecordingForegroundService';

function addRecordingService(manifest) {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  app.service = (app.service || []).filter((s) => s.$['android:name'] !== SERVICE);
  app.service.push({
    $: {
      'android:name': SERVICE,
      'android:exported': 'false',
      'android:foregroundServiceType': 'microphone',
    },
  });
  return manifest;
}

function withRecordingCompliance(config) {
  config = withInfoPlist(config, (c) => {
    const modes = new Set(c.modResults.UIBackgroundModes || []);
    modes.add('audio');
    c.modResults.UIBackgroundModes = [...modes];
    return c;
  });
  config = withAndroidManifest(config, (c) => {
    c.modResults = addRecordingService(c.modResults);
    return c;
  });
  return AndroidConfig.Permissions.withPermissions(config, [
    'android.permission.RECORD_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  ]);
}

module.exports = withRecordingCompliance;
module.exports.addRecordingService = addRecordingService;
module.exports.SERVICE = SERVICE;
