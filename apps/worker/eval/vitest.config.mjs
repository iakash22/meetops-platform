// Offline eval for the production worker prompts (meeting-summary@1, action-items@1). Run with
// `pnpm --filter @meetops/worker eval`. Not part of `pnpm test`: eval files end in .eval.ts, which the default
// vitest include does not match, and the main config also excludes eval/**.
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['eval/**/*.eval.ts'],
    reporters: ['verbose'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
