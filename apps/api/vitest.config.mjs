// .mjs (not .ts) so type-aware lint does not need it in a tsconfig project.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Relaxed (in-memory) deps are only allowed for NODE_ENV=development|test.
    env: { NODE_ENV: 'test' }
  }
});
