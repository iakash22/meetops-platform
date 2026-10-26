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
pnpm --filter @meetops/web build
node apps/web/scripts/check-bundle-size.mjs          # table; exit 1 on a breach
node apps/web/scripts/check-bundle-size.mjs --json   # machine-readable
```

There are no dependencies (node:fs and node:zlib). Budgets are gzip kB per chunk name, set in
`BUDGETS` at the top of the script. Any JS chunk over 500 kB raw also fails. It is not wired
into `package.json` yet.

## Route-level code splitting

Every page module is loaded with `lazyRouteComponent(() => import(...), 'Name')` in
`src/routes/router.tsx`, `account.tsx`, `organization.tsx` and `auth-public.tsx`. Layouts, guards
and search parsers (`features/tasks/task-search.ts`, `features/settings/settings-search.ts`) stay
in the entry so redirects never wait on a page chunk. `defaultPreload: 'intent'` fetches a page on
link hover/focus; `RoutePending` (static skeleton, shimmer off under reduced motion) shows only
after the router's 1 s pending delay. Entry chunk: 137.23 kB / 40.12 kB gz → 74.63 kB / 24.15 kB gz.
