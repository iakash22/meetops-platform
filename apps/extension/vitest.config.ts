import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests only: resolve @meetops/contracts from source so the extension's tests run standalone,
  // without building packages/contracts first. The extension build (WXT) is unaffected.
  resolve: {
    alias: {
      '@meetops/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
