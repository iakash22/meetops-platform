import type { ExpoConfig } from 'expo/config';

// Placeholder identifiers only. Replace before any store submission.
// No secrets, tokens or credentials belong in this file.
/** Plain-language purpose string (plan.md "iOS background audio"). */
export const MICROPHONE_PURPOSE =
  'MeetOps records meeting audio you choose to capture so it can be transcribed for your organization.';

const config: ExpoConfig = {
  name: 'MeetOps',
  slug: 'meetops-mobile',
  scheme: 'meetops',
  version: '0.0.0',
  orientation: 'portrait',
  // Dark-first brand (owner decision). Colours live in src/theme/colors.ts.
  userInterfaceStyle: 'dark',
  backgroundColor: '#0A0A0A',
  platforms: ['ios', 'android'],
  ios: {
    bundleIdentifier: 'com.example.meetops',
    supportsTablet: false,
  },
  android: {
    package: 'com.example.meetops',
    // Keep Keystore-backed auth items (and everything else) out of Android Auto Backup / device transfer.
    allowBackup: false,
  },
  plugins: [
    'expo-router',
    ['expo-secure-store', { configureAndroidBackup: true }],
    ['expo-audio', { microphonePermission: MICROPHONE_PURPOSE }],
    './plugins/withRecordingCompliance',
  ],
  experiments: { typedRoutes: false },
};

export default config;
