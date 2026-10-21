import { defineWorkspace } from 'vitest/config';

// Optional: point @meetops/contracts at another checkout (e.g. PR #17) for contract runs.
// Always resolve contracts from source so tests never run against a stale dist/ build.
const contractsDir = process.env.QA_CONTRACTS_DIR ?? new URL('../packages/contracts', import.meta.url).pathname;
const alias = { '@meetops/contracts': `${contractsDir}/src/index.ts` };
const base = { environment: 'node' as const, alias };

// One vitest project per suite. E2E is run by Playwright, not vitest.
export default defineWorkspace([
  { test: { ...base, name: 'api', include: ['api/**/*.test.ts'] } },
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
]);
