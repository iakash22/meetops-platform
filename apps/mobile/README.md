# @meetops/mobile

Expo (SDK 52) + expo-router + strict TypeScript app for iOS and Android.
Status: **M1 scaffold only**. There is no recording, auth, or upload code yet.

## Commands (from repo root, pnpm 9.12.3 per `packageManager`)

```sh
pnpm install
pnpm --filter @meetops/mobile start      # Expo dev server
pnpm --filter @meetops/mobile lint       # eslint . (root flat config)
pnpm --filter @meetops/mobile typecheck  # tsc --noEmit (strict)
pnpm --filter @meetops/mobile test       # jest (jest-expo + RNTL)
```

CI runs mobile lint, typecheck and test through the existing root `turbo run`
jobs. CI runs no EAS builds.

## Config

- `app.config.ts`: placeholder ids `com.example.meetops` (iOS bundle id and Android package). Replace them before any store build.
- `eas.json`: `development`, `preview` and `production` profiles. There are no credentials in the repo. EAS credentials are managed outside git.
- `@meetops/contracts` is a workspace dependency stub. It isn't imported yet and hasn't been changed.
- Identity naming: always `organizationId` (never `orgId` / `tenantId`).

## Root changes

`package.json` has `pnpm.peerDependencyRules` because the repo uses `strict-peer-dependencies=true`. That block ignores the missing `webpack` peer (expo-router web only) and allows React 18 for jest-expo's `react-server-dom-webpack`.

See [docs/mobile/plan.md](../../docs/mobile/plan.md) for the roadmap and the security requirements.
