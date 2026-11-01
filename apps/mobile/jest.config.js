/* global module */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // Shared CI/dev boxes run many suites at once; RN render tests that pass in ~1 s locally hit Jest's 5 s default
  // under load (e.g. task-review "accepts, then edits with a minimal patch"). Bound the workers and raise the timeout.
  testTimeout: 30_000,
  maxWorkers: 2,
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
  // @meetops/contracts only exposes an ESM `import` condition, which Jest's CommonJS resolver does not match.
  // Point tests at its built entry (turbo runs `^build` before `test`) so they can read the runtime reason lists.
  moduleNameMapper: {
    '^@meetops/contracts$': '<rootDir>/../../packages/contracts/dist/index.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation(/.*|\\+.*)|@sentry/react-native|native-base|react-native-svg|decode-uri-component))',
  ],
};
