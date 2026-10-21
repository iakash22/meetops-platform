import { defineWorkspace } from 'vitest/config';

// Optional: point @meetops/contracts at another checkout (e.g. PR #17) for contract runs.
const contractsDir = process.env.QA_CONTRACTS_DIR;
const alias = contractsDir ? { '@meetops/contracts': `${contractsDir}/src/index.ts` } : undefined;
const base = { environment: 'node' as const, ...(alias && { alias }) };

// One vitest project per suite. E2E is run by Playwright, not vitest.
export default defineWorkspace([
  { test: { ...base, name: 'api', include: ['api/**/*.test.ts'] } },
  { test: { ...base, name: 'contract', include: ['contract/**/*.test.ts'] } },
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
