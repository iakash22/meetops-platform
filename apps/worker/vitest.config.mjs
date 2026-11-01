// .mjs so type-aware lint does not need it in a tsconfig project.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Full turbo `pnpm test` runs many packages at once; default 5s flakes under load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
