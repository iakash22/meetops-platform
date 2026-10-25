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
7. [MCP servers and plugins](#7-mcp-servers-and-plugins)
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
