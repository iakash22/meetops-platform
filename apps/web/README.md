# @meetops/web

React + Vite SPA for MeetOps AI.

Stack: TanStack Router (code-based route tree), TanStack Query, Zustand, Tailwind CSS v3, shadcn/ui (`components.json`, components in `src/components/ui`), react-hook-form + zod, Vitest + Testing Library.

## Layout

- `src/routes/router.tsx` – route tree: auth (`/login`, `/signup`, `/forgot-password`) and app shell (`/`, `/meetings`, `/tasks`, `/projects`, `/settings`)
- `src/components/layout` – app shell, sidebar, top bar, org switcher placeholder
- `src/components/states` – empty / loading / error states
- `src/features/auth` – auth forms and zod schemas
- `src/lib/api` – typed API client stub, React context, query hooks; `types.ts` holds temporary domain types pending `@meetops/contracts`
- `src/lib/query-client.ts` – TanStack Query client factory
- `test/` – tests; mock data lives only in `test/fixtures`

## Scripts

`pnpm --filter @meetops/web dev | build | lint | typecheck | test`

Env: `VITE_API_URL` (defaults to `/api`).

Add shadcn components with `npx shadcn@2.3.0 add <component>` from `apps/web` (2.x targets Tailwind v3).
