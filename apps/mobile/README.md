# @meetops/mobile

Expo (SDK 52) + expo-router + strict TypeScript app for iOS and Android.
Status: **M2 auth shell + bottom tabs (demo mode)**. Sign-in, organization switcher, route
guards and four tabs (Meetings, Record, Tasks, Account) run against a **mock** auth client and
placeholder repositories. There is no real network auth, no audio capture and no upload code yet.

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
- `@meetops/contracts` provides the types (`LoginRequest`, `GetAuthSessionResponse`, `OrganizationWithRole`, `Meeting`, ...) and `REDACT_KEYS` / `ApiErrorCode` values via `@meetops/contracts/types`. It hasn't been changed. See the contracts import rule below.
- `tsconfig.json` uses `module: esnext` + `moduleResolution: bundler` so the `@meetops/contracts/types` subpath export resolves for `tsc`.
- `babel.config.js` sets `enableBabelRuntime: false`: helpers are inlined because `@babel/runtime` is not a direct dependency and is unresolvable for Metro under pnpm's isolated layout (adding it would change the lockfile).
- Identity naming: always `organizationId` (never `orgId` / `tenantId`).

## Auth shell and tabs (M2)

```
app/_layout.tsx                 AuthProvider + RepositoriesProvider + dark StatusBar + root Stack
app/(auth)/_layout.tsx          guard: signed-in users are redirected to /
app/(auth)/login.tsx            sign-in screen
app/(app)/_layout.tsx           guard: signed-out users are redirected to /login; Stack of tabs + modal
app/(app)/(tabs)/_layout.tsx    bottom tabs (rose active tint, dark bar, View-drawn icons)
app/(app)/(tabs)/index.tsx      Meetings: active organization + placeholder list
app/(app)/(tabs)/record.tsx     Record: preview-only UI shell (no audio captured)
app/(app)/(tabs)/tasks.tsx      Tasks: placeholder list
app/(app)/(tabs)/account.tsx    Account: user, organization + role, switch, sign out, app version
app/(app)/organizations.tsx     organization switcher (modal)
```

- `src/auth/sessionManager.ts`: framework-free session state (`loading | signedOut | signedIn`), restore, sign in, sign out, org switch, single-flight token refresh and wipe hooks. `AuthProvider` / `useAuth` wrap it for React.
- `src/auth/tokenStore.ts`: `TokenStore` interface + `createInMemoryTokenStore()`. **expo-secure-store is a separate follow-up PR** (lockfile owned by another lane).
- `src/auth/mockAuthClient.ts`: mirrors ADR-005 (opaque tokens, 15-min access TTL, rotating refresh with reuse detection revoking the family, 30-day family cap, org-scoped tokens, generic `AUTH_FAILED`).
- `src/api/client.ts`: typed client for the real API (`POST /auth/signup` -> 202 without a session, `POST /auth/login`, `GET /auth/session`, `GET /orgs`, `POST /orgs/switch` -> `{ organization, role }`, `POST /auth/logout` -> 204). Bearer header only, `credentials: 'omit'`, never a token in a URL. Not wired into the app until the mobile bearer flow lands in the API.
- Logout and org switch wipe local data (plan R4): tokens are cleared and registered wipe hooks run.
- `src/services.ts`: **demo mode** (`IS_DEMO_MODE`). The mock accepts any well-formed credentials and the login screen shows a demo notice. Replace with the real client before any release.
- Data sources sit behind typed interfaces in `src/data/` (`MeetingsRepository`, `TasksRepository`, `UploadQueue`) and reach screens through `RepositoriesProvider`. All three are placeholders: the API has no list-meetings or list-tasks route yet and there is no native recording. `useOrgScopedList` reloads on an org switch and drops results of the previous organization.
- Every list has skeleton (loading), empty and error (with retry) states.
- **Record tab is a preview.** `src/record/recorderShell.ts` is a pure idle/recording/paused/stopped state machine with a wall-clock timer. While `RECORDING_ENABLED` is false the screen says "Preview only", nothing is captured, and Stop says nothing was saved. The upload-queue card reads the placeholder queue (always empty).

## Theme

`src/theme/colors.ts` is the single token file, synced with the web theme
(`docs/05-web/brand-theme.md`; shadcn-style names). Screens never hard-code hex values.

| Token                                   | Value                 | Use                                                                    |
| --------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `background`                            | `#0A0A0A`             | app background                                                         |
| `foreground`                            | `#F5F5F7`             | body text                                                              |
| `card` / `muted`                        | `#141416`             | cards, tab bar                                                         |
| `secondary` / `popover`                 | `#1C1C1F`             | raised surfaces, skeleton bars                                         |
| `mutedForeground`                       | `#A1A1AA`             | secondary text, inactive tabs                                          |
| `border`                                | `#2A2A2E`             | card borders                                                           |
| `input`                                 | `#6B6B73`             | input borders (3:1 on surfaces)                                        |
| `primary` / `primaryForeground`         | `#007BA7` / `#FFFFFF` | primary buttons                                                        |
| `link` / `ring`                         | `#3AB0E0`             | text links and focus (`#007BA7` text on black fails AA)                |
| `accent` / `accentForeground`           | `#FF2D95` / `#0A0A0A` | active tab, live and recording states; about one rose element per view |
| `destructive` / `destructiveForeground` | `#EF4444` / `#0A0A0A` | errors and sign out; never Neon Rose                                   |
| `warning`                               | `#F5A524`             | preview notice, offline                                                |

Plus `radius` (6/8/12/16/full), `spacing`, `glow` (12px, .45 cerulean / .35 rose, brand
elements only) and `motion` (150/200 ms). `__tests__/theme.test.ts` checks WCAG AA for every
text pairing. Motion uses React Native built-ins only (`Animated`, `Pressable`): CTA press scale,
live dot pulse, skeleton shimmer and the record halo are all skipped when the OS reduce-motion
setting is on (`useReducedMotion`).

## Root changes

`package.json` has `pnpm.peerDependencyRules` because the repo uses `strict-peer-dependencies=true`. That block exists only for the mobile Expo toolchain (JSON allows no comments, so the note lives here):

- `ignoreMissing: ["webpack"]` covers optional web-only peers pulled in by **expo-router** (`schema-utils`) and **jest-expo** (`react-server-dom-webpack`). Mobile never bundles with webpack.
- `allowedVersions` lets jest-expo's `react-server-dom-webpack` accept the repo's React 18.

`pnpm.overrides` also carries mobile-only audit fixes for Expo build tooling (HIGH advisories):

- `@expo/plist>@xmldom/xmldom: ^0.8.15` (0.7.13 has the CDATA/attribute/element injection and ReDoS advisories). `@expo/plist` only uses `DOMParser`, which is unchanged in 0.8.
- `@expo/metro-config>postcss: ^8.5.18` (8.4.49 has the source-map path traversal and file read advisories). This is a minor bump within postcss 8.
- `image-size@1.2.1` (via `metro@0.81.5`) is **not** overridden. The fix is in 2.0.3, but 2.x drops the callable default export and file-path input that metro's `Assets.js` relies on. It is build-time only (asset dimensions during bundling) and goes away with an Expo SDK upgrade.

See [docs/mobile/plan.md](../../docs/mobile/plan.md) for the roadmap and the security requirements.

## Contracts import rule (Architecture)

- Mobile may import **values** only from `@meetops/contracts/types`.
- Imports from the `@meetops/contracts` root must be `import type { ... }`.
- No server packages (`@meetops/database`, `@meetops/ai-core`, integrations, `@meetops/queue`, `@meetops/logger`), no other apps, and no deep `src/` or `dist/` imports.
- Architecture owns the contracts package and will add a `default` export condition there. Mobile does not edit it.
