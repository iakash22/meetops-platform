import type { ExpoConfig } from 'expo/config';

// Placeholder identifiers only. Replace before any store submission.
// No secrets, tokens or credentials belong in this file.
const config: ExpoConfig = {
  name: 'MeetOps',
  slug: 'meetops-mobile',
  scheme: 'meetops',
  version: '0.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  platforms: ['ios', 'android'],
  ios: {
    bundleIdentifier: 'com.example.meetops',
    supportsTablet: false,
  },
  android: {
    package: 'com.example.meetops',
  },
  plugins: ['expo-router'],
  experiments: { typedRoutes: false },
};

export default config;
