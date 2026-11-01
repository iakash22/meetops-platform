// .mjs so type-aware lint does not need it in a tsconfig project.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file boots one or more Socket.IO servers. Under a full turbo `pnpm test`
    // (many packages compiling/running at once) the default 5s timeout flakes on
    // `await start()` and on revalidation waits that need a full 1s interval.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Avoid N concurrent listen()+handshake suites fighting for ports/CPU on Windows.
    fileParallelism: false,
  },
});
