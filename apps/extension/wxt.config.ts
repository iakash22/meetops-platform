import { defineConfig } from 'wxt';
import { manifest } from './src/manifest.js';

/** Dev-only pairing origin (ADR-005 A1.1.5): never part of a production/store build. */
const DEV_WEB_ORIGINS = ['http://localhost:3000/*'];

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: 'dist',
  manifestVersion: 3,
  manifest: ({ mode }) =>
    mode === 'development'
      ? {
          ...manifest,
          externally_connectable: {
            matches: [...manifest.externally_connectable.matches, ...DEV_WEB_ORIGINS],
          },
        }
      : manifest,
});
