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

## Not done yet: route-level code splitting

All routes live in `src/routes/router.tsx`, so page modules are still in the entry chunk. The
follow-up (after FE-1 `feat/web-directory` and `fix/web-auth-flows` merge) switches page
components to `lazyRouteComponent(...)`. The exact diff is in the perf/web-bundle PR description.
