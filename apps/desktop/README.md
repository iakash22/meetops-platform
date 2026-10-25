# @meetops/desktop

MeetOps AI desktop app: a [Tauri 2](https://v2.tauri.app/) shell around a React + Vite + TypeScript
(strict) + Tailwind 4 frontend. It shares types with the other apps through `@meetops/contracts` and
uses the web app's UI conventions (shadcn-style primitives on Radix, `cva`, `lucide-react`).

**Status: M1 scaffold.** An app shell with a **mocked** sign-in, a meetings list with placeholder
data and a settings screen. No server calls, no recording yet. See [Desktop plan (Phase 8)](#desktop-plan-phase-8).

## Layout

```
apps/desktop
├── index.html, vite.config.ts      Vite app (dev server on :1420, the port Tauri expects)
├── src/
│   ├── app.tsx                     SessionProvider + sign-in gate + view switcher
│   ├── components/ui/              shadcn-style primitives (button, card, input, badge, alert, ...)
│   ├── components/layout/          collapsible sidebar app shell
│   ├── features/auth/              AuthClient interface, in-memory mock, session context, sign-in screen
│   ├── features/meetings/          meetings list (placeholder rows typed as contracts `Meeting`)
│   ├── features/settings/          account, app info (from Rust), offline-recording placeholder
│   └── lib/native.ts               Tauri bridge: invoke('app_info') with a browser fallback
├── test/                           vitest + Testing Library (jsdom), incl. tauri.conf guards
└── src-tauri/                      Rust side (Tauri 2): one read-only `app_info` command
```

## Scripts

| Script                               | What it does                                     | Needs Rust? |
| ------------------------------------ | ------------------------------------------------ | ----------- |
| `pnpm --filter @meetops/desktop dev` | Vite dev server in the browser (Browser preview) | No          |
| `... build`                          | `vite build` to `dist/` (what turbo/CI runs)     | No          |
| `... lint` / `typecheck` / `test`    | ESLint, `tsc --noEmit`, vitest                   | No          |
| `... tauri:dev`                      | Native window with hot reload                    | Yes         |
| `... tauri:build`                    | Native bundles (`.dmg`/`.msi`/`.deb`/...)        | Yes         |

The root `pnpm build | lint | typecheck | test` only run the frontend scripts, so **CI and other
lanes never need the Rust toolchain**. `src-tauri/` is excluded from ESLint and `tsconfig`.

### Native prerequisites (only for `tauri:*`)

Rust (stable, 1.85+ was used to verify) and the platform deps from the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Linux: `libwebkit2gtk-4.1-dev`,
`libgtk-3-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`; macOS: Xcode CLT; Windows: WebView2 +
MSVC). Rust unit tests: `cd apps/desktop/src-tauri && cargo test`.

## Owner TODOs

- **Bundle identifier**: `src-tauri/tauri.conf.json` uses the placeholder
  `ai.meetops.desktop.todo-owner` (TODO-owner). Replace it with the real reverse-DNS identifier for the
  owned domain before any signed or distributed build; it cannot change after release without
  breaking updates and app data paths. A test keeps the `todo-owner` marker visible until then.
- **Desktop auth model**: ADR-005 covers only the browser extension. The desktop needs its own ADR
  (e.g. system-browser OAuth/PKCE or pairing, tokens in the OS keychain). Until then sign-in is a mock
  (`src/features/auth/mock-auth.ts`, marked `TODO(desktop-auth)`): any well-formed email + non-empty
  password works, `*@invalid.test` shows the error path, and no token material exists anywhere.
- **Code signing / notarization** (Apple Developer ID, Windows Authenticode) and the updater key.
- **Icons**: `src-tauri/icons/` are generated placeholders (`pnpm tauri icon <1024px png>`).

## Theme

Dark-first owner palette, shared token names with `apps/web` (`src/index.css`, HSL triplets used via
`hsl(var(--x))` and Tailwind 4 `@theme`):

| Token                                 | Colour               | Use                                                        |
| ------------------------------------- | -------------------- | ---------------------------------------------------------- |
| `--background`                        | `#0A0A0A`            | app background (Jet Black)                                 |
| `--surface` / `--card`, `--surface-2` | `#141416`, `#1C1C1F` | sidebar/cards, inputs/hover                                |
| `--border` / `--input`                | `#2A2A2E`            | borders                                                    |
| `--primary` / `--ring`                | `#007BA7`            | buttons, links, focus rings (Cerulean)                     |
| `--accent`                            | `#FF2D95`            | active state, record button, badges (Neon Rose, sparingly) |
| `--foreground`, `--muted-foreground`  | `#F5F5F7`, `#A1A1AA` | text, muted text                                           |

As in the web app, `--muted` is a muted **fill** and `--muted-foreground` is the muted **text**
colour. Modern touches are CSS only (no motion library): `glow-card`, the `gradient-border` record
button and a soft sign-in backdrop. All transitions are disabled under `prefers-reduced-motion`.

## Security notes

- Strict CSP in `tauri.conf.json` (no `unsafe-eval`, no inline scripts; `freezePrototype`).
- The default capability grants `core:default` only; add plugin permissions explicitly and minimally.
- The one Rust command (`app_info`) takes no input and returns name/version/OS/arch only.
- The session is held in memory; nothing is written to disk except the sidebar collapse preference.

## Desktop plan (Phase 8)

Goal: record meetings **offline** on the desktop and sync them to MeetOps reliably and safely.

- **Consent first**: recording starts only from an explicit user action, with a persistent visible
  indicator (Neon Rose record state, tray/dock badge) and per-org consent notices. No covert or
  background recording, no auto-start.
- **Local capture**: microphone (and later system audio where the OS allows) to chunked files in the
  app data dir, **encrypted at rest** with a per-device key held in the OS keychain.
- **Offline queue**: recordings are queued with metadata (title, time, org) and survive restarts and
  crashes (resumable chunks, integrity hashes).
- **Upload**: when online, chunked upload over TLS to **pre-signed URLs** issued by the API for the
  user's active organization (tenant-scoped), with retry/backoff and resume; then the meeting moves
  through the normal processing pipeline (`source: 'desktop'`).
- **Auth**: per the desktop auth ADR; tokens only in the OS keychain (never localStorage or files),
  short-lived, revocable per device.
- **Retention**: local copies deleted after a confirmed upload (or after an org-configurable window),
  with a manual "delete local recording" action.
- **Least privilege**: only the Tauri plugins/permissions each milestone needs, reviewed per PR.

Milestones:

1. **M1 (this PR)**: scaffold, app shell, mocked sign-in, meetings placeholder, settings, `app_info`.
2. **M2**: real auth per ADR, API client, live meetings list (read-only).
3. **M3**: local recording + encrypted storage + consent UX.
4. **M4**: offline queue and resumable pre-signed uploads.
5. **M5**: signing/notarization, auto-update, release pipeline.
