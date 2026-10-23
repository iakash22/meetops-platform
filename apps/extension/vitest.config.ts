import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const contracts = (file: string) =>
  fileURLToPath(new URL(`../../packages/contracts/src/${file}`, import.meta.url));

export default defineConfig({
  // Tests only: resolve @meetops/contracts (and its /types entry) from source so the extension's tests run
  // standalone, without building packages/contracts first. The extension build (WXT) is unaffected.
  resolve: {
    alias: [
      { find: /^@meetops\/contracts\/types$/, replacement: contracts('types.ts') },
      { find: /^@meetops\/contracts$/, replacement: contracts('index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
