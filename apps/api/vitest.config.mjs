// .mjs (not .ts) so type-aware lint does not need it in a tsconfig project.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pnpm coverage` (vitest run --coverage). Thresholds sit just below measured coverage: raise them, never lower.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      thresholds: { statements: 82, branches: 73, functions: 77, lines: 84 },
    },
    // Relaxed (in-memory) deps are only allowed for NODE_ENV=development|test.
    env: { NODE_ENV: 'test' },
    // Each createServer()/buildApp() compiles every route's response serializer and validator
    // (fast-json-stringify + ajv codegen): ~0.8 s CPU per instance warm, ~2.4 s for the first one in a
    // file (cold transform). Tests that build 2+ instances plus signup/org setup fit in Vitest's 5 s
    // default on an idle box but time out when local gates share the box with other pnpm runs. The cost is
    // CPU-bound and per instance, so the limit is raised for this project only. Assertions are unchanged.
    // Directory/auth suites also boot Fastify + signup/login; under a full turbo `pnpm test`,
    // argon2 + cold imports routinely exceed 30s when the machine is busy.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
