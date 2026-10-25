/* global module */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
  // @meetops/contracts only exposes an ESM `import` condition, which Jest's CommonJS resolver does not match.
  // Point tests at its built entry (turbo runs `^build` before `test`) so they can read the runtime reason lists.
  moduleNameMapper: {
    '^@meetops/contracts$': '<rootDir>/../../packages/contracts/dist/index.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation(/.*|\\+.*)|@sentry/react-native|native-base|react-native-svg))',
  ],
};
