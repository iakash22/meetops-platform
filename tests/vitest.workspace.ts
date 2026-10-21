import { defineWorkspace } from 'vitest/config';

// One vitest project per suite. E2E is run by Playwright, not vitest.
export default defineWorkspace([
  { test: { name: 'api', include: ['api/**/*.test.ts'], environment: 'node' } },
  { test: { name: 'contract', include: ['contract/**/*.test.ts'], environment: 'node' } },
  { test: { name: 'factories', include: ['factories/**/*.test.ts'], environment: 'node' } },
  {
    test: {
      name: 'integration',
      include: ['integration/**/*.test.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 180_000
    }
  }
]);
