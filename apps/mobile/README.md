# @meetops/mobile

Expo (SDK 52) + expo-router + strict TypeScript app for iOS and Android.
Status: **M1 scaffold only**. There is no recording, auth, or upload code yet.

## Commands (from repo root, pnpm 9.12.3 per `packageManager`)

```sh
pnpm install
pnpm --filter @meetops/mobile start      # Expo dev server
pnpm --filter @meetops/mobile lint       # eslint . (root flat config)
pnpm --filter @meetops/mobile typecheck  # tsc --noEmit (strict)
pnpm --filter @meetops/mobile test       # jest (jest-expo + RNTL), then bundle:check
pnpm --filter @meetops/mobile bundle:check  # expo export android+ios to a temp dir
```

CI runs mobile lint, typecheck and test through the existing root `turbo run`
jobs. `test` includes the `bundle:check` export smoke step, so CI catches Metro
resolution failures without any `ci.yml` change. CI runs no EAS builds.

`metro.config.js` is set up for the pnpm monorepo: `watchFolders` points at the repo root, `nodeModulesPaths` covers the app and root `node_modules`, and package exports are enabled. `query-string` is a direct dependency because expo-router 4 requires it without declaring it, which breaks under pnpm's isolated layout.

## Config

- `app.config.ts`: placeholder ids `com.example.meetops` (iOS bundle id and Android package). Replace them before any store build.
- `eas.json`: `development`, `preview` and `production` profiles. There are no credentials in the repo. EAS credentials are managed outside git.
- `@meetops/contracts` is a workspace dependency stub. It isn't imported yet and hasn't been changed. See the contracts import rule below.
- Identity naming: always `organizationId` (never `orgId` / `tenantId`).

## Root changes

`package.json` has `pnpm.peerDependencyRules` because the repo uses `strict-peer-dependencies=true`. That block exists only for the mobile Expo toolchain (JSON allows no comments, so the note lives here):

- `ignoreMissing: ["webpack"]` covers optional web-only peers pulled in by **expo-router** (`schema-utils`) and **jest-expo** (`react-server-dom-webpack`). Mobile never bundles with webpack.
- `allowedVersions` lets jest-expo's `react-server-dom-webpack` accept the repo's React 18.

See [docs/mobile/plan.md](../../docs/mobile/plan.md) for the roadmap and the security requirements.

## Contracts import rule (Architecture)

- Mobile may import **values** only from `@meetops/contracts/types`.
- Imports from the `@meetops/contracts` root must be `import type { ... }`.
- No server packages (`@meetops/database`, `@meetops/ai-core`, integrations, `@meetops/queue`), no other apps, and no deep `src/` or `dist/` imports.
- Architecture owns the contracts package and will add a `default` export condition there. Mobile does not edit it.
