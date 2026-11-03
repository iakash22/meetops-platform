/// <reference types="vitest" />
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { localCsp } from './csp.config';

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
  [
    'bootstrap',
    [
      'react-bootstrap',
      'bootstrap',
      '@restart/',
      'uncontrollable',
      'invariant',
      'warning',
      'prop-types',
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

const monorepoRoot = fileURLToPath(new URL('../..', import.meta.url));

const nginxTemplate = () =>
  readFileSync(new URL('../../infra/docker/nginx/web.conf.template', import.meta.url), 'utf8');

function envPort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Upstream API for the Vite `/api` proxy (dev only). Prefer VITE_API_PROXY_TARGET, else PORT/API_PORT. */
function apiProxyTarget(env: Record<string, string>): string {
  const explicit = env.VITE_API_PROXY_TARGET?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return `http://127.0.0.1:${envPort(env.PORT ?? env.API_PORT, 3000)}`;
}

/** Upstream apps/realtime for the Vite `/socket.io` proxy (dev only). VITE_REALTIME_PROXY_TARGET, else REALTIME_PORT. */
function realtimeProxyTarget(env: Record<string, string>): string {
  const explicit = env.VITE_REALTIME_PROXY_TARGET?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  return `http://127.0.0.1:${envPort(env.REALTIME_PORT, 4001)}`;
}

/**
 * Client base URL for the browser. Same-origin `/api` uses the Vite proxy in `server.proxy`.
 * An absolute `http(s)://…` URL skips the proxy (needs API CORS).
 */
function resolveViteApiUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || value === '/') return '/api';
  return value.replace(/\/$/, '') || '/api';
}

export default defineConfig(({ mode, command }) => {
  // Root `.env` (not apps/web/.env): VITE_API_URL, WEB_PORT, PORT, etc.
  // Empty prefix so WEB_PORT/PORT are available for the dev server; Vite still only
  // exposes VITE_* to the client via import.meta.env.
  const env = loadEnv(mode, monorepoRoot, '');
  const viteApiUrl = resolveViteApiUrl(env.VITE_API_URL);
  const proxyTarget = apiProxyTarget(env);
  const rtProxyTarget = realtimeProxyTarget(env);
  const rtPath = (env.VITE_REALTIME_PATH || '/socket.io').replace(/\/$/, '');
  const template = nginxTemplate();
  const devNonce = randomBytes(18).toString('base64url');
  return {
    ...(command === 'serve' ? { html: { cspNonce: devNonce } } : {}),
    preview: { headers: { 'Content-Security-Policy': localCsp(template) } },
    plugins: [react(), apiPreconnect(viteApiUrl)],
    envDir: monorepoRoot,
    // Ensure the client always sees a concrete base (empty .env → `/api` → proxy).
    define: {
      'import.meta.env.VITE_API_URL': JSON.stringify(viteApiUrl),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: envPort(env.WEB_PORT, 5173),
      headers: { 'Content-Security-Policy': localCsp(template, devNonce) },
      proxy: {
        // Browser → http://localhost:WEB_PORT/api/… → API (strips `/api` prefix).
        // Cookie + CSRF stay same-origin when VITE_API_URL=/api.
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api(?=\/|$)/, '') || '/',
        },
        // Browser → ws://localhost:WEB_PORT/socket.io/… → apps/realtime (WebSocket upgrade, path kept).
        // Same origin, so the host-only session cookie rides on the upgrade (leave VITE_REALTIME_URL empty).
        [rtPath]: {
          target: rtProxyTarget,
          ws: true,
          changeOrigin: false,
        },
      },
    },
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
      // Full turbo `pnpm test` runs many packages at once; default 5s flakes under load.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // Serial files: parallel jsdom suites race auth redirects / query caches under turbo load.
      fileParallelism: false,
    },
  };
});
