# Web bundle performance

## Chunking (`apps/web/vite.config.ts`)

Production builds target `es2022`, keep CSS code-splitting on, and split long-lived vendor code into
groups (`manualChunks`) so an app-only deploy does not invalidate the browser cache for vendors:

| chunk        | packages                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| `react`      | react, react-dom, scheduler, use-sync-external-store                     |
| `tanstack`   | `@tanstack/*` (router, query, history, store)                            |
| `radix`      | `@radix-ui/*`, `@floating-ui/*`, react-remove-scroll and its helpers     |
| `icons`      | lucide-react (named imports only, so it tree-shakes to the icons in use) |
| `validation` | zod, react-hook-form, `@hookform/*`                                      |
| `index`      | app code plus small utilities (clsx, cva, tailwind-merge, zustand)       |

If `VITE_API_URL` is an absolute URL on another origin, the build adds `preconnect` and
`dns-prefetch` hints for it to `index.html`. The default same-origin `/api` adds nothing.

## Budget check

```sh
pnpm size                                            # turbo: web build (cached) then the budget table; exit 1 on a breach
pnpm --filter @meetops/web size --json              # machine-readable (needs a web build)
node apps/web/scripts/check-bundle-size.mjs --dist <dir>   # another build output
```

There are no dependencies (node:fs and node:zlib). Budgets are gzip kB per chunk name, set in
`BUDGETS` at the top of the script. Rows marked `*` are the initial JS (the entry script and modulepreloads
in `dist/index.html`), budgeted together as `initialJs` (185 kB gz); `totalJs` (290 kB gz) covers every
chunk, lazy ones included. Baseline when wired in (integration/phase-1 @e4aceac4): initial JS
156.43 kB, all JS 249.31 kB, `index` 38.34 kB, CSS 9.02 kB gz. The `index` (35 → 45) and CSS
(8 → 11) budgets and the all-JS total (220 → 290) were raised to that baseline plus ~15-20%
headroom, because the app had outgrown the original perf/web-bundle numbers. Any JS chunk over 500 kB raw also fails. It is wired in as
the `size` script of `@meetops/web` and a turbo `size` task (`dependsOn: build`), which runs in
`pnpm local-gates` right after the build and in CI after `pnpm build`. Exit 2 (no `dist/`) also
fails the gate. When a chunk legitimately grows, raise its budget in the same PR and say why.

## Route-level code splitting

Every page module is loaded with `lazyRouteComponent(() => import(...), 'Name')` in
`src/routes/router.tsx`, `account.tsx`, `organization.tsx` and `auth-public.tsx`. Layouts, guards
and search parsers (`features/tasks/task-search.ts`, `features/settings/settings-search.ts`) stay
in the entry so redirects never wait on a page chunk. `defaultPreload: 'intent'` fetches a page on
link hover/focus; `RoutePending` (static skeleton, shimmer off under reduced motion) shows only
after the router's 1 s pending delay. Entry chunk: 137.23 kB / 40.12 kB gz → 74.63 kB / 24.15 kB gz.
