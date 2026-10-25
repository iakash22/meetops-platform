/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Long-lived vendor groups. Each group changes on its own release cadence, so splitting them
 * keeps the browser cache warm across app deploys and keeps every chunk under the 500 kB warning.
 * Order matters: the first matching group wins.
 */
const VENDOR_GROUPS: ReadonlyArray<readonly [chunk: string, packages: readonly string[]]> = [
  ['react', ['react', 'react-dom', 'scheduler', 'use-sync-external-store']],
  ['tanstack', ['@tanstack/']],
  [
    'radix',
    [
      '@radix-ui/',
      '@floating-ui/',
      'react-remove-scroll',
      'react-remove-scroll-bar',
      'react-style-singleton',
      'use-callback-ref',
      'use-sidecar',
      'aria-hidden',
      'get-nonce',
      'tslib',
    ],
  ],
  ['icons', ['lucide-react']],
  // Not 'forms': that name is taken by the src/features/auth/forms route chunk once routes are lazy.
  ['validation', ['zod', 'react-hook-form', '@hookform/']],
];

/** Package name for a resolved module id inside node_modules (pnpm layout aware). */
function packageName(id: string): string | undefined {
  const idx = id.lastIndexOf('/node_modules/');
  if (idx === -1) return undefined;
  const [scopeOrName = '', name = ''] = id.slice(idx + '/node_modules/'.length).split('/');
  return scopeOrName.startsWith('@') ? `${scopeOrName}/${name}` : scopeOrName;
}

export function vendorChunk(id: string): string | undefined {
  const pkg = packageName(id);
  if (!pkg) return undefined;
  for (const [chunk, packages] of VENDOR_GROUPS) {
    if (packages.some((p) => (p.endsWith('/') ? pkg.startsWith(p) : pkg === p))) return chunk;
  }
  return undefined;
}

/**
 * When the API lives on another origin (absolute VITE_API_URL), let the browser open the
 * TLS connection while the JS is still downloading. Same-origin '/api' needs nothing.
 */
function apiPreconnect(apiUrl: string | undefined): Plugin {
  return {
    name: 'meetops:api-preconnect',
    transformIndexHtml() {
      if (!apiUrl || !/^https?:\/\//i.test(apiUrl)) return [];
      const origin = new URL(apiUrl).origin;
      return [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: origin, crossorigin: 'use-credentials' },
          injectTo: 'head',
        },
        { tag: 'link', attrs: { rel: 'dns-prefetch', href: origin }, injectTo: 'head' },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), apiPreconnect(env.VITE_API_URL)],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173 },
    build: {
      target: 'es2022',
      cssCodeSplit: true,
      modulePreload: { polyfill: false },
      reportCompressedSize: true,
      rollupOptions: {
        output: { manualChunks: vendorChunk },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      css: false,
    },
  };
});
