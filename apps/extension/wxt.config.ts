import { defineConfig } from 'wxt';
import { resolveOrigins } from './src/lib/auth/origins.js';
import { buildManifest } from './src/manifest.js';
import { missingPrivacyUrlWarning } from './src/lib/privacy-url.js';

/**
 * WXT loads .env files into process.env before evaluating these functions. Origins are validated here, so a bad
 * WXT_WEB_ORIGIN / WXT_API_ORIGIN fails the build, and the same web origin drives externally_connectable.
 */
const origins = (mode: string) => resolveOrigins(process.env, mode === 'development');

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: 'dist',
  manifestVersion: 3,
  manifest: ({ mode }) => buildManifest(origins(mode).webOrigin),
  vite: ({ mode, command }) => {
    const { webOrigin, apiOrigin } = origins(mode);
    // `wxt prepare` (postinstall / lint / typecheck) also uses command "build" and
    // production mode. Only warn on a real `wxt build` production compile.
    const isWxtPrepare = process.argv.some((arg) => /(^|\/)prepare$/.test(arg));
    if (command === 'build' && mode === 'production' && !isWxtPrepare) {
      const warning = missingPrivacyUrlWarning(process.env.WXT_PRIVACY_URL);
      if (warning) console.warn(warning);
    }
    return {
      // WXT hard-codes server.watch on the internal vite server it uses to import entrypoints, so `wxt prepare`
      // (run by lint/typecheck/postinstall) opens a chokidar watcher and fails with ENOSPC when inotify watches
      // are exhausted. Outside `wxt dev`, nothing needs watching: null tells vite to skip the watcher.
      plugins:
        command === 'serve'
          ? []
          : [
              {
                name: 'meetops:no-watch-outside-dev',
                config(config) {
                  config.server = { ...config.server, watch: null };
                },
              },
            ],
      define: {
        'import.meta.env.WXT_WEB_ORIGIN': JSON.stringify(webOrigin),
        'import.meta.env.WXT_API_ORIGIN': JSON.stringify(apiOrigin),
        // Raw flag value; httpUploadEnabled() in src/lib/features.ts resolves the default
        // (on in development builds, off in production builds and in tests).
        'import.meta.env.WXT_FEATURE_HTTP_UPLOAD': JSON.stringify(
          process.env.WXT_FEATURE_HTTP_UPLOAD ?? '',
        ),
        // Feature flag (off unless 'true' / '1'): single-file upload via POST /orgs/:org/uploads.
        'import.meta.env.WXT_FEATURE_DIRECT_UPLOAD': JSON.stringify(
          process.env.WXT_FEATURE_DIRECT_UPLOAD ?? '',
        ),
        'import.meta.env.WXT_PRIVACY_URL': JSON.stringify(process.env.WXT_PRIVACY_URL ?? ''),
      },
    };
  },
});
