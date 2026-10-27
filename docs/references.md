# Design references, MCP servers and plugins

One place for every design/UI reference, asset source, MCP server and dev plugin the MeetOps
clients use. Every external URL here was checked on 2026-10-25 (HTTP 200 unless noted). Licence
notes are summaries of each vendor's own page at that date; re-check the linked licence before
shipping something new.

Contents:

1. [Brand and theme](#1-brand-and-theme)
2. [Component libraries](#2-component-libraries)
3. [Assets and effects](#3-assets-and-effects)
4. [Layout and flow inspiration](#4-layout-and-flow-inspiration)
5. [Auth page references](#5-auth-page-references)
6. [Typography and motion](#6-typography-and-motion)
7. [MCP servers and dev plugins](#7-mcp-servers-and-dev-plugins)
8. [Framework decisions recap](#8-framework-decisions-recap)
9. [How to use these references (rules)](#9-how-to-use-these-references-rules)

## 1. Brand and theme

Dark-first; there is no light theme. The full token table, contrast checks and per-platform file
locations are in `docs/05-web/brand-theme.md` (currently **on `integration/phase-1`**; it reaches
`main` with the integration → main PR).

| Role                   | Hex       | Notes                                                                       |
| ---------------------- | --------- | --------------------------------------------------------------------------- |
| Jet Black (background) | `#0A0A0A` | App background on every client                                              |
| Cerulean (primary)     | `#007BA7` | Primary buttons, fills, borders, glows. **Not for text on black** (≈4.1:1). |
| Link / focus ring      | `#3AB0E0` | Links, cerulean text on dark, focus rings (≈8:1 on `#0A0A0A`, passes AA)    |
| Neon Rose (highlight)  | `#FF2D95` | Active nav, live/record dot, small badges. Use sparingly.                   |
| Destructive (errors)   | `#EF4444` | Errors and danger. **Never use rose for errors.**                           |

Why `#3AB0E0` exists: `#007BA7` on `#0A0A0A` fails WCAG 2.1 AA for normal text, so cerulean is
only a fill colour and `#3AB0E0` carries cerulean text and rings.

## 2. Component libraries

All of these are **copy-into-our-repo** libraries: we install the source into
`apps/web/src/components/` (via the shadcn CLI or by pasting), then restyle it to our tokens. No
runtime dependency on the vendor.

| Library              | URL                       | What we use it for                                                                                                                                                                                                  | Licence (checked 2026-10-25)                                                                                                                                                                                                                                |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **shadcn/ui** (base) | https://ui.shadcn.com     | Base primitives (Button, Input, Dialog, Card, Form…), login/signup blocks, the CLI and registry system everything else plugs into. Vite install guide: https://ui.shadcn.com/docs/installation/vite                 | MIT ([LICENSE](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md))                                                                                                                                                                                       |
| **21st.dev**         | https://21st.dev          | Community shadcn components to borrow micro-interactions from (sign-in variants, animated inputs). Installs through the shadcn CLI.                                                                                 | Each component keeps its author's licence. [Terms](https://21st.dev/terms) forbid redistributing components without a visible link back to the original 21st.dev page, and forbid scraping. Keep the source URL in a comment at the top of the copied file. |
| **Aceternity UI**    | https://ui.aceternity.com | Free animated effects: signup-form focus glow, spotlight/beam backgrounds. `npx shadcn@latest add @aceternity/<name>`                                                                                               | Free tier: use in unlimited personal and commercial products, not MIT; you may not resell or redistribute the components as a library ([licence](https://ui.aceternity.com/licence)). **Pro blocks are paid: do not buy or use them.**                      |
| **Animate UI**       | https://animate-ui.com    | Motion primitives: ripple/liquid buttons, shimmering text, animated `input-otp`. Docs: https://animate-ui.com/docs/components                                                                                       | MIT + Commons Clause ([LICENSE](https://github.com/imskyleen/animate-ui/blob/main/LICENSE.md)): fine inside our app; never redistribute the components themselves.                                                                                          |
| **Watermelon UI**    | https://ui.watermelon.sh  | Free auth blocks (`auth-01`…), form components wired with react-hook-form + zod + sonner. `npx shadcn@latest add https://registry.watermelon.sh/r/auth-01.json`                                                     | MIT, no paid tier ([free components page](https://ui.watermelon.sh/free/react-components), [source](https://github.com/WatermelonCorp/watermelon-platform))                                                                                                 |
| **Magic UI**         | https://magicui.design    | Shimmer button for the single signup CTA, border beam for cards. [Shimmer Button](https://www.magicui.design/docs/components/shimmer-button), [Border Beam](https://www.magicui.design/docs/components/border-beam) | MIT ([LICENSE](https://github.com/magicuidesign/magicui/blob/main/LICENSE.md))                                                                                                                                                                              |

Rules for every library above:

- **Copy into our components**, don't import from a vendor package. Replace hard-coded colours
  with our tokens (`bg-background`, `text-link`, `ring-ring`, `bg-highlight`, `bg-destructive`).
- **Respect reduced motion.** Every animation must be wrapped in `motion-safe:` /
  `@media (prefers-reduced-motion: no-preference)` or Motion's `useReducedMotion()`. Under
  `reduce`, show the static end state. Focus rings stay visible (they are not animation).
- Keep accessibility intact after restyling: labels, `aria-*`, keyboard focus, ≥44px tap targets.
- Free tiers only. Never paste code from a paid tier (Aceternity Pro, Tailwind Plus, paid 21st.dev
  items) into this repo.

## 3. Assets and effects

| Source          | URL                     | Use                                                                                                                                   | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ls.graphics** | https://www.ls.graphics | Device mockups and illustrations for marketing, docs and the auth brand panel ([free mockups](https://www.ls.graphics/free-mockups)). | **FREE assets only, never purchase.** Their [terms of service](https://www.ls.graphics/terms-of-service) allow free assets in personal and commercial projects but forbid reselling or sharing the source files. So commit only exported images (PNG/WebP/AVIF), never the PSD/Figma source.                                                                                                                                                                     |
| **shaders.com** | https://shaders.com     | WebGPU animated backgrounds (React components: https://shaders.com/react) for the auth brand panel and hero areas.                    | The engine, components and bindings are MIT ([licence](https://shaders.com/license)). Pro presets are paid ([pricing](https://shaders.com/pricing)): don't buy them. **Lazy-load** the shader with `React.lazy` and dynamic `import()`. Render only when `navigator.gpu` exists **and** `prefers-reduced-motion: no-preference`. Always keep a static CSS gradient fallback (cerulean radial glow on `#0A0A0A`) that shows first and stays if WebGPU is missing. |

## 4. Layout and flow inspiration

Look-only references. We study layouts and flows, then build our own; never copy screenshots or
assets from them into the repo.

| Source         | URL                   | Use                                                                                                                                                                                                                           |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mobbin**     | https://mobbin.com    | Real app screens and flows (web + iOS/Android), e.g. [web login screens](https://mobbin.com/explore/web/screens/login), [logging-in flows](https://mobbin.com/explore/web/flows/logging-in). Some content needs a free login. |
| **Page Flows** | https://pageflows.com | Recorded end-to-end user flows, e.g. [signing up](https://pageflows.com/web/flows/signing-up/), [logging in](https://pageflows.com/web/flows/logging-in/).                                                                    |
| **Land-book**  | https://land-book.com | Landing-page and marketing-site layouts for `apps/marketing`.                                                                                                                                                                 |

## 5. Auth page references

Shortlist for `/login`, `/signup`, forgot/reset password and verify email (researched
2026-10-25; every link returned 200).

| Reference                                                                                                                  | What to take from it                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Supabase sign-in](https://supabase.com/dashboard/sign-in)                                                                 | Split screen: form column left, testimonial panel right. Password show/hide eye, inline "Forgot password?" in the label row, legal line pinned to the bottom. |
| [Resend login](https://resend.com/login)                                                                                   | Dark, centered, minimal; ambient art from the corners (closest to our BrandBackground glow); CTA disabled until input is valid.                               |
| [Vercel login](https://vercel.com/login)                                                                                   | Pure black, high contrast; "Sign up" pill top-right.                                                                                                          |
| [Linear login](https://linear.app/login) / [signup](https://linear.app/signup)                                             | Narrow column, one headline, strict type scale and spacing on near-black.                                                                                     |
| [Cal.com signup](https://app.cal.com/signup)                                                                               | The "signup sells the product" panel: framed product preview, three value props, "Already have an account? Sign in" pinned bottom-left.                       |
| [shadcn login blocks](https://ui.shadcn.com/blocks/login) / [signup blocks](https://ui.shadcn.com/blocks/signup)           | Code base to start from. `login-02` = two columns with cover panel; `login-04` = card with form + image. `npx shadcn add login-02`.                           |
| [Watermelon auth-01](https://ui.watermelon.sh/block/auth-01) + [form components](https://ui.watermelon.sh/components/form) | react-hook-form + zod + sonner wiring for validation and toasts.                                                                                              |
| [21st.dev sign-in](https://21st.dev/s/sign-in) / [sign-up](https://21st.dev/s/sign-up)                                     | Micro-interactions to borrow (animated sign-in, split screen, auth divider). Keep the attribution link.                                                       |
| [Aceternity signup form](https://ui.aceternity.com/components/signup-form)                                                 | Cursor-following radial glow on input hover/focus; copy it in cerulean.                                                                                       |
| [Mobbin web login screens](https://mobbin.com/explore/web/screens/login)                                                   | Benchmark error, verification and "check your email" states.                                                                                                  |

Also useful: [Page Flows signing-up](https://pageflows.com/web/flows/signing-up/),
[Magic UI Shimmer Button](https://www.magicui.design/docs/components/shimmer-button),
[Animate UI components](https://animate-ui.com/docs/components).

Key spec points:

- **The API is email + password only.** There are no SSO/Google/GitHub/magic-link/passkey
  endpoints, so **render no SSO buttons and no "or" divider** until the API adds OAuth.
- Signup = full name → work email → password (12–128 chars, mirrors `packages/contracts`) with a
  strength meter → one shimmer CTA. No confirm-password field.
- Signup, forgot-password and resend are enumeration-safe: signup always ends on a "Check your
  email" state, never "email already taken".
- Login = email (`autoComplete="username"`) + password (`current-password`) on one screen; login
  only checks the password is non-empty, so the policy isn't revealed.
- Fetch `GET /auth/csrf` before submit and send `x-csrf-token`; on `CSRF_INVALID`, refetch once and
  retry.
- **Error rule:**
  - **Field errors appear inline under the field** (`aria-invalid`, `aria-describedby`, destructive
    border). On submit, focus the first invalid field.
  - **Non-field errors appear as an animated toast** using [Sonner](https://sonner.emilkowal.ski)
    (MIT, [source](https://github.com/emilkowalski/sonner)), themed to our tokens. That covers
    `AUTH_FAILED`, `RATE_LIMITED`, network/5xx and expired sessions. Error toasts use
    `#EF4444`, never rose. Don't auto-dismiss toasts that need action, and keep them ≥5s.
    The toast animation is skipped under reduced motion.
- Loading: fixed-width button, spinner + label, `aria-busy`, block double submit.
- Mobile: brand panel hidden below `lg`, 16px inputs, `h-11` controls, `min-h-svh`.
- Neon rose at most once per page (e.g. a "New" pill), never for errors or CTAs.

## 6. Typography and motion

Self-hosted variable fonts (woff2), both under the SIL Open Font License (OFL):

| Font                      | Role                    | Loading                        | Official site                                                                                                    |
| ------------------------- | ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Inter (variable)          | Sans: UI and body text  | Preloaded; latin subset ≈57 KB | [rsms.me/inter](https://rsms.me/inter/) ([repo](https://github.com/rsms/inter))                                  |
| JetBrains Mono (variable) | Mono: timecodes and IDs | Lazy-loaded                    | [jetbrains.com/lp/mono](https://www.jetbrains.com/lp/mono/) ([repo](https://github.com/JetBrains/JetBrainsMono)) |

The full guide (type scale, spacing, scroll and motion system) is at
`docs/05-web/typography-and-motion.md`, via
[PR #143](https://github.com/iakash22/meetops-platform/pull/143) into `integration/phase-1` (not
yet on `main`). Don't load fonts from a third-party CDN; use the self-hosted files.

## 7. MCP servers and dev plugins

All of these were checked against their official docs on 2026-10-25. **Never commit keys or
tokens:** configs read them from your shell environment or an OAuth sign-in. Keep personal MCP
configs (`.cursor/mcp.json`, `.vscode/mcp.json`, `~/.claude.json`) out of git unless they hold
no secrets.

### MCP servers

| Server                                                                                                                                                                                                                                                                 | Use it for                                                                                                                                                                                   | Install / config                                                                                                                                                                                   | Auth                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [shadcn MCP](https://ui.shadcn.com/docs/mcp)                                                                                                                                                                                                                           | Browse, search and install shadcn registry components (incl. `@aceternity`, `@magicui`, Watermelon registries)                                                                               | `pnpm dlx shadcn@latest mcp init --client cursor` (or `--client claude` / `vscode`)                                                                                                                | None for public registries; private registries read `${REGISTRY_TOKEN}` from env |
| [21st.dev MCP](https://21st.dev/mcp) ([repo](https://github.com/21st-dev/magic-mcp))                                                                                                                                                                                   | Generate/fetch UI components and inspiration from the 21st.dev library                                                                                                                       | `npx @21st-dev/cli@latest init --client cursor`; legacy `npx -y @21st-dev/magic@latest` still proxies                                                                                              | API key from 21st.dev in env (`API_KEY_21ST`); old Magic keys were reset         |
| [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/) ([remote install](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/), [guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Dev-Mode-MCP-Server)) | Read frames, variables and code-connect from designs                                                                                                                                         | Remote: `https://mcp.figma.com/mcp`; desktop: enable the Dev Mode MCP server in the Figma desktop app                                                                                              | Figma OAuth; desktop server needs a Dev/Full seat on a paid plan                 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp)                                                                                                                                                                                                          | Drive a browser to check pages, flows and screenshots                                                                                                                                        | `npx @playwright/mcp@latest`                                                                                                                                                                       | None                                                                             |
| [GitHub MCP](https://github.com/github/github-mcp-server)                                                                                                                                                                                                              | Issues, PRs, Actions from the agent                                                                                                                                                          | Remote: `https://api.githubcopilot.com/mcp/`; local: Docker `ghcr.io/github/github-mcp-server`. Limit with `GITHUB_TOOLSETS="repos,issues,pull_requests,actions"` and `--read-only` where possible | OAuth, or a PAT in env `GITHUB_PERSONAL_ACCESS_TOKEN` (never in the file)        |
| [Context7](https://github.com/upstash/context7) ([site](https://context7.com), [all clients](https://context7.com/docs/resources/all-clients))                                                                                                                         | Up-to-date library docs (React, Vite, TanStack, Tailwind, Expo, WXT, Tauri…)                                                                                                                 | `npx ctx7 setup` (Node ≥ 22.13), or remote `https://mcp.context7.com/mcp`; package `@upstash/context7-mcp`                                                                                         | Optional free key (rate limits) as `Authorization: Bearer` from env              |
| [Expo MCP](https://docs.expo.dev/eas/ai/mcp/)                                                                                                                                                                                                                          | Expo docs, `add_library`, EAS builds/workflows, simulator screenshots/taps                                                                                                                   | Remote: `https://mcp.expo.dev/mcp`; local tools: `pnpm expo install expo-mcp --dev` then `EXPO_UNSTABLE_MCP_SERVER=1 pnpm expo start` (SDK 54+)                                                    | Expo account OAuth; doc search needs a paid EAS plan                             |
| Tauri: no official MCP                                                                                                                                                                                                                                                 | Use the official [llms.txt](https://tauri.app/llms.txt) or Context7. Community option: [mcp-server-tauri](https://github.com/hypothesi/mcp-server-tauri) (**unofficial**, review before use) | n/a                                                                                                                                                                                                | n/a                                                                              |
| WXT: no official MCP                                                                                                                                                                                                                                                   | Use the official [llms.txt](https://wxt.dev/llms.txt) or Context7                                                                                                                            | n/a                                                                                                                                                                                                | n/a                                                                              |

Example `.cursor/mcp.json` (no secrets in the file):

```json
{
  "mcpServers": {
    "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] },
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "figma": { "url": "https://mcp.figma.com/mcp" },
    "expo": { "url": "https://mcp.expo.dev/mcp" }
  }
}
```

VS Code uses `.vscode/mcp.json` with a top-level `"servers"` key instead of `"mcpServers"`.

### Editor and build plugins

| Tool                                                                                                                                                                                     | Why                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) ([repo](https://github.com/tailwindlabs/tailwindcss-intellisense))            | Class autocomplete, token hover previews, lint for conflicting classes |
| [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)                                                                                                           | Static accessibility checks in JSX                                     |
| [@axe-core/playwright](https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright)                                                                                       | Automated a11y scans inside Playwright e2e tests                       |
| [rollup-plugin-visualizer](https://github.com/btd/rollup-plugin-visualizer)                                                                                                              | Inspect Vite bundle size to keep heavy effects within budget           |
| Expo [debugging tools](https://docs.expo.dev/debugging/tools/), [dev tools](https://docs.expo.dev/develop/tools/), [DevTools plugins](https://docs.expo.dev/debugging/devtools-plugins/) | Debugging the React Native + Expo app                                  |
| [WXT docs](https://wxt.dev/guide/introduction.html)                                                                                                                                      | Extension (MV3) framework guide                                        |
| [Tauri v2 docs](https://v2.tauri.app)                                                                                                                                                    | Desktop shell guide                                                    |

## 8. Framework decisions recap

From `docs/PROJECT_CONTEXT.md` (status refreshed 27 Oct 2026; see `docs/PHASE_STATUS.md`):

| Client                               | Stack                                       | Status           |
| ------------------------------------ | ------------------------------------------- | ---------------- |
| Web (`apps/web`)                     | React + Vite, TanStack, Tailwind, shadcn/ui | Active           |
| Mobile (`apps/mobile`)               | React Native + Expo                         | Built (Phase 8)  |
| Browser extension (`apps/extension`) | WXT, Manifest V3                            | Built            |
| Desktop (`apps/desktop`)             | Tauri                                       | Built (Phase 8)  |

The same brand tokens (section 1) apply on every client. Only web uses the shadcn-based
libraries directly; mobile, extension and desktop take the look and patterns, not the code.

## 9. How to use these references (rules)

1. **Free assets only.** Use free tiers and free downloads (ls.graphics freebies, shaders.com
   open-source components, free shadcn-ecosystem components). Don't buy Pro tiers, templates or
   asset packs without an explicit decision recorded in an issue/PR. Paid sites (e.g. Tailwind
   Plus) are for looking only; don't copy their code.
2. **Attribution where licences require it.** Keep MIT notices for copied component code, keep
   credit/links that 21st.dev authors or asset licences ask for, and note the source URL in a code
   comment when you copy a component. Never redistribute source files (ls.graphics, Aceternity).
3. **Copy, don't depend.** Copy a component into the app through the shadcn CLI and adapt it to
   our tokens, rather than pulling a whole UI kit as a dependency.
4. **No secrets in docs or configs.** No API keys, PATs, OAuth secrets or registry tokens in this
   file, in MCP config files or in code. Use environment variables or OAuth sign-in;
   `gitleaks` runs in pre-commit and CI (see `docs/12-security/secrets-policy.md`).
5. **Performance budget.** Lazy-load heavy effects (shaders, WebGL, canvas, large Lottie/video)
   with `React.lazy`/dynamic `import()` after first paint, and give each one a static CSS
   fallback (gradient or image). Skip them on `prefers-reduced-motion` and on low-power/mobile
   where reasonable. Check bundle impact with rollup-plugin-visualizer before merging.
6. **Accessibility is not optional.** Meet WCAG AA contrast with our tokens, keep visible focus
   rings (`#3AB0E0`), tap targets ≥ 44px, and respect reduced motion.
7. **Keep this file current.** When you add a reference, MCP server or plugin, verify the URL and
   licence the same day and record anything unverified as such.
