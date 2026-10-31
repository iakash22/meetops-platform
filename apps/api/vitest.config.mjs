// .mjs (not .ts) so type-aware lint does not need it in a tsconfig project.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Relaxed (in-memory) deps are only allowed for NODE_ENV=development|test.
    env: { NODE_ENV: 'test' },
    // Each createServer()/buildApp() compiles every route's response serializer and validator
    // (fast-json-stringify + ajv codegen): ~0.8 s CPU per instance warm, ~2.4 s for the first one in a
    // file (cold transform). Tests that build 2+ instances plus signup/org setup fit in Vitest's 5 s
    // default on an idle box but time out when local gates share the box with other pnpm runs. The cost is
    // CPU-bound and per instance, so the limit is raised for this project only. Assertions are unchanged.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
