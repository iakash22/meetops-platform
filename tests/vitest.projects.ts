// Optional: point @meetops/contracts at another checkout (e.g. PR #17) for contract runs.
// Always resolve contracts from source so tests never run against a stale dist/ build.
const contractsDir =
  process.env.QA_CONTRACTS_DIR ?? new URL('../packages/contracts', import.meta.url).pathname;
// Regex aliases: a plain '@meetops/contracts' key is a prefix match, so the subpath
// '@meetops/contracts/types' became 'src/index.ts/types' (ENOTDIR). Map the root and each
// subpath export (./types, ./legacy) to its source file instead.
const alias = [
  { find: /^@meetops\/contracts$/, replacement: `${contractsDir}/src/index.ts` },
  { find: /^@meetops\/contracts\/(.*)$/, replacement: `${contractsDir}/src/$1` },
];
// 15s default: API suites boot an in-process server per test and hit vitest's 5s default under load.
// hookTimeout must match: project configs override CLI --hookTimeout, and createServer() in
// beforeAll regularly exceeds vitest's 10s hook default under turbo contention.
const base = {
  environment: 'node' as const,
  alias,
  testTimeout: 15_000,
  hookTimeout: 60_000,
};

// One vitest project per suite. E2E is run by Playwright, not vitest.
// Plain array (no defineWorkspace, which vitest 4 removes). Used by vitest.config.ts as
// `test.projects` (vitest >= 3.2) or as the workspace file (vitest 2.x / 3.0-3.1).
export const projects = [
  // API suites drive real password hashing (AU-01 does 10+ logins); under turbo load 30s flakes.
  {
    test: {
      ...base,
      name: 'api',
      include: ['api/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
  { test: { ...base, name: 'contract', include: ['contract/**/*.test.ts'] } },
  {
    test: {
      ...base,
      name: 'security',
      include: ['security/**/*.test.ts', 'fixtures/**/*.test.ts'],
    },
  },
  { test: { ...base, name: 'factories', include: ['factories/**/*.test.ts'] } },
  {
    test: {
      ...base,
      name: 'integration',
      include: ['integration/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 180_000,
    },
  },
];

export default projects;
