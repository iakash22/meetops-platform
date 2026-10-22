import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Relaxed (in-memory) deps are only allowed for NODE_ENV=development|test.
    env: { NODE_ENV: 'test' }
  }
});
