# MeetOps brand theme

Owner-selected palette (Maddy, 2026-10-25), applied to **every** client: web, browser extension,
mobile (Expo) and desktop (Tauri). Dark-first; there is no light theme.

Brand source colours: **Jet Black `#0A0A0A`**, **Cerulean Blue `#007BA7`**, **Neon Rose `#FF2D95`**.

## Tokens

Use these exact hex values on every platform. Web exposes them as CSS variables (HSL channels,
consumed as `hsl(var(--token))` by Tailwind); the extension uses `--mo-*` CSS variables; mobile
should mirror the names in `src/theme/colors.ts`, desktop in its CSS.

| Token (web CSS var / Tailwind)                    | Extension var                 | Mobile key (suggested)  | Hex       | Use                                                                    |
| ------------------------------------------------- | ----------------------------- | ----------------------- | --------- | ---------------------------------------------------------------------- |
| `--background` / `bg-background`                  | `--mo-background`             | `background`            | `#0A0A0A` | App background (Jet Black)                                             |
| `--card` / `bg-card`, `--muted` / `bg-muted`      | `--mo-surface-1`              | `surface1`              | `#141416` | Cards, sidebar, raised surfaces                                        |
| `--popover`, `--secondary`, `--accent`            | `--mo-surface-2`              | `surface2`              | `#1C1C1F` | Popovers, menus, hover/selected rows, secondary buttons                |
| `--border` / `border-border`                      | `--mo-border`                 | `border`                | `#2A2A2E` | 1px dividers and card borders (decorative)                             |
| `--input` / `border-input`                        | `--mo-input`                  | `inputBorder`           | `#6B6B73` | Form-control borders (≥3:1 vs background)                              |
| `--foreground` (+ all `*-foreground` on surfaces) | `--mo-foreground`             | `foreground`            | `#F5F5F7` | Body text                                                              |
| `--muted-foreground`                              | `--mo-muted-foreground`       | `mutedForeground`       | `#A1A1AA` | Secondary text, placeholders                                           |
| `--primary` / `bg-primary`                        | `--mo-primary`                | `primary`               | `#007BA7` | Primary buttons/fills (Cerulean)                                       |
| — (hover)                                         | `--mo-primary-hover`          | `primaryPressed`        | `#00698F` | Primary hover/pressed                                                  |
| `--primary-foreground`                            | `--mo-primary-foreground`     | `primaryForeground`     | `#FFFFFF` | Text on primary                                                        |
| `--link` / `text-link`, `--ring`                  | `--mo-link`, `--mo-ring`      | `link`, `ring`          | `#3AB0E0` | Links and cerulean text on dark; focus rings                           |
| `--highlight` / `bg-highlight`, `text-highlight`  | `--mo-highlight`              | `accent`                | `#FF2D95` | Neon Rose: active nav, highlights, record/live dot, badges — sparingly |
| `--highlight-foreground`                          | `--mo-highlight-foreground`   | `accentForeground`      | `#0A0A0A` | Text on rose fills                                                     |
| `--destructive`                                   | `--mo-destructive`            | `destructive`           | `#EF4444` | Errors/danger; red, distinct from rose                                 |
| `--destructive-foreground`                        | `--mo-destructive-foreground` | `destructiveForeground` | `#0A0A0A` | Text on destructive fills                                              |
| —                                                 | `--mo-warning`                | `warning`               | `#F5A524` | Warnings (extension storage warning)                                   |

Glow (optional, brand/logo elements only — no heavy shadows elsewhere):
`0 0 12px rgba(0,123,167,.45)` (cerulean) and `0 0 12px rgba(255,45,149,.35)` (rose). Web utility: `.brand-glow` (text) / `.brand-glow-box`.

> Note: shadcn's `accent` token is intentionally a **neutral** hover surface (`#1C1C1F`), because
> components use `hover:bg-accent` everywhere. The brand rose lives in `highlight`.

## Contrast (WCAG 2.1 AA)

| Pair                                            | Ratio           | Result                                   |
| ----------------------------------------------- | --------------- | ---------------------------------------- |
| `#F5F5F7` on `#0A0A0A` / `#1C1C1F`              | 18.2 / 15.6     | AA/AAA                                   |
| `#A1A1AA` on `#0A0A0A` / `#141416` / `#1C1C1F`  | 7.7 / 7.2 / 6.6 | AA                                       |
| `#FFFFFF` on `#007BA7` (primary button)         | 4.78            | AA                                       |
| `#FFFFFF` on `#00698F` (primary hover)          | 6.15            | AA                                       |
| `#007BA7` on `#0A0A0A` as text                  | 4.14            | **fails** → use `#3AB0E0` for text/links |
| `#3AB0E0` on `#0A0A0A` / `#1C1C1F`              | 7.98 / 6.85     | AA                                       |
| `#FF2D95` on `#0A0A0A` / `#1C1C1F`              | 5.71 / 4.91     | AA                                       |
| `#0A0A0A` on `#FF2D95` (rose badge)             | 5.71            | AA (white would be 3.46 — fails)         |
| `#EF4444` on `#0A0A0A` / `#141416` (error text) | 5.26 / 4.89     | AA                                       |
| `#0A0A0A` on `#EF4444` (destructive button)     | 5.26            | AA (white would be 3.76 — fails)         |
| `#6B6B73` input border on `#0A0A0A`             | 3.75            | ≥3:1 non-text                            |
| `#3AB0E0` focus ring on `#0A0A0A`               | 7.98            | ≥3:1 non-text                            |

## Where it lives

- Web: `apps/web/src/index.css` (variables), `apps/web/tailwind.config.ts` (`popover`, `highlight`, `link` colours). `index.html` sets `class="dark"` and `color-scheme: dark`.
- Extension: `apps/extension/entrypoints/popup/theme.css` (imported by the popup).
- Mobile / desktop lanes: copy the hex values above verbatim; do not derive new shades.

## Design patterns (shared UI primitives)

Conventions follow [shadcn/ui](https://ui.shadcn.com): HSL channel CSS variables consumed as
`hsl(var(--token))`, `cva` variants, `asChild` via Radix `Slot`, and component files in
`apps/web/src/components/ui`.

| Pattern     | Rule                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Radius      | `--radius: 0.75rem`. `rounded-md` 8px (inputs, buttons), `rounded-lg` 12px (cards, popovers), `rounded-xl` 16px (hero/feature cards, toasts), `rounded-full` (badges, live dot).                                                                                   |
| Surfaces    | Layered, not shadowed: `background` #0A0A0A → `card` #141416 → `popover`/`secondary` #1C1C1F, each with a 1px `border` #2A2A2E. No drop shadows on cards or buttons.                                                                                               |
| Glass       | `.surface-glass` (card at 72% + `backdrop-blur 12px`) for the sticky top bar; `bg-popover/95 backdrop-blur` for Select content. Use only on overlays/nav.                                                                                                          |
| Focus       | Global `:focus-visible` outline and `ring-2 ring-ring ring-offset-2 ring-offset-background` on controls. Ring is cerulean-light #3AB0E0 (7.98:1). Never remove focus styles.                                                                                       |
| Active/live | Rose (`highlight`) only: active nav item (2px inset bar + icon), `Badge variant="live"` (pulsing dot), `Badge variant="highlight"`, recording indicators. Keep it to roughly one rose element per view.                                                            |
| Motion      | Tokens `duration-instant/fast/base/slow` (100/150/200/300ms), easings `ease-out` `cubic-bezier(.2,.8,.2,1)` and `ease-standard` `cubic-bezier(.4,0,.2,1)`. Full rules incl. reduced motion: [typography-and-motion.md](./typography-and-motion.md#motion).         |
| Typography  | Self-hosted **Inter** (variable, Latin subset) + **JetBrains Mono** for timecodes/IDs; semantic scale `text-display`, `text-h1`…`text-h6`, `text-body`, `text-small`, `text-caption`, `text-overline`. See [typography-and-motion.md](./typography-and-motion.md). |
| Spacing     | Tailwind 4px scale. Page `max-w-content p-4 sm:p-6 lg:p-8`, card `p-6`, stack gaps `gap-4`/`gap-6`, sections `gap-12`. Layout tokens and density: [typography-and-motion.md](./typography-and-motion.md#spacing-and-layout).                                       |

### Components

| Component                                                                         | File                         | Notes                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                                                                          | `ui/button.tsx`              | Variants `default` · `destructive` · `outline` · `secondary` · `ghost` · `link` · **`highlight`** (rose, primary CTA on marketing only) · **`shimmer`** (cerulean with CSS sheen).                                                                                           |
| `Badge`                                                                           | `ui/badge.tsx`               | Pill shape. New **`highlight`** and **`live`** (rose pulsing dot; pair with text like "Live" / "Recording").                                                                                                                                                                 |
| `Textarea`                                                                        | `ui/textarea.tsx`            | shadcn API (`React.ComponentProps<'textarea'>`, forwards ref). Same tokens/focus ring as `Input`; `aria-invalid="true"` → destructive border/ring. `autoResize` uses CSS `field-sizing: content` (Chromium 123+), elsewhere a normal resizable textarea; cap with `max-h-*`. |
| `Skeleton`                                                                        | `ui/skeleton.tsx`            | `bg-muted` + shimmer, `aria-hidden`. Pair with an sr-only "Loading…" in the parent `LoadingState`.                                                                                                                                                                           |
| `EmptyState`                                                                      | `states/states.tsx`          | Grid backdrop, icon tile, title, description and optional action. `role="status"`.                                                                                                                                                                                           |
| `toast` / `<Toaster/>`                                                            | `ui/toast.tsx`               | Sonner-compatible API (`toast()`, `toast.success`, `toast.error`, `toast.dismiss`) on a tiny zustand store, so a later swap to `sonner` is a one-file change. Mounted once in `app.tsx`.                                                                                     |
| `SpotlightCard`                                                                   | `ui/spotlight-card.tsx`      | Pointer-following cerulean radial glow via CSS variables (no animation library). Static under reduced motion.                                                                                                                                                                |
| `GradientBorder`                                                                  | `ui/spotlight-card.tsx`      | Rotating conic cerulean→rose 1px border (`@property --border-angle`); static gradient where `@property` is unsupported or motion is reduced.                                                                                                                                 |
| `NumberTicker`                                                                    | `ui/number-ticker.tsx`       | `requestAnimationFrame` count-up for KPI cards; final value rendered immediately under reduced motion and always exposed to screen readers.                                                                                                                                  |
| `BrandBackground`                                                                 | `brand/brand-background.tsx` | Auth/hero backdrop: black base, cerulean + rose radial glows, masked grid. Pure CSS, `aria-hidden`, reserved `data-slot="brand-background-shader"` for the shader follow-up.                                                                                                 |
| Utilities `.bg-grid` `.shimmer` `.gradient-border` `.surface-glass` `.brand-glow` | `index.css`                  | Building blocks for the above.                                                                                                                                                                                                                                               |

Layout: collapsible-ready sticky sidebar (`bg-card/60`, rose active item), glass sticky top bar
(`z-40`) with room on the right for a command-palette trigger (`⌘K`), cards in a responsive grid
(`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`), auth pages as a centred card over `BrandBackground`.

#### Wiring `BrandBackground` into auth (owner of `routes/router.tsx` / `features/auth`)

```tsx
import { BrandBackground } from '@/components/brand/brand-background';

<BrandBackground className="flex min-h-screen items-center justify-center p-6">
  <Outlet /> {/* login / signup card */}
</BrandBackground>;
```

Not wired in this PR because `router.tsx` and `features/auth/*` belong to another lane.

## Shader background follow-up (shaders.com)

The `shaders` npm package (MIT, v4.x, WebGPU, React entry `shaders/react`) is **not** added. Plan:

1. Add it only in a dedicated PR, imported via `React.lazy(() => import('./brand-shader'))` from
   `BrandBackground` so it lands in its own async chunk. Verify with the Vite build report that
   the main entry chunk does not grow.
2. Mount only on auth and landing routes, into `[data-slot="brand-background-shader"]`.
3. Load only when all are true: `'gpu' in navigator` and `await navigator.gpu.requestAdapter()`
   succeeds; `matchMedia('(prefers-reduced-motion: reduce)')` is false; not low-power
   (`navigator.hardwareConcurrency >= 4`, `navigator.deviceMemory` ≥ 4 when available,
   `navigator.connection?.saveData` not set); and the tab is visible.
4. Otherwise keep the CSS fallback, which is the same colours and composition, so there is no layout shift.
   Pause the render loop on `visibilitychange` and cap the frame rate at 30fps.
5. Shaders Pro (editor/MCP) is paid and out of scope.

## Follow-ups (need deps or other lanes)

- Motion components that need `motion`/`framer-motion`: animated beams, spring number ticker,
  layout-animated tabs, magnetic buttons, Aceternity/Animate UI/Watermelon text effects.
- **Lockfile queue:** Dialog, Sheet (mobile sidebar) and Tabs primitives need `@radix-ui/react-dialog` and `@radix-ui/react-tabs` (versions matching the existing `@radix-ui/*` majors). Not added here; build the shadcn `Dialog`/`Sheet`/`Tabs` wrappers once the lockfile owner lands them.
- Command palette in the top bar: `cmdk` (shadcn `Command`).
- Swap `ui/toast.tsx` for `sonner` if desired (API-compatible).
- WebGPU shader background (above).
- Wire `BrandBackground` into the auth layout (router lane).
- Collapsible sidebar state (persisted) once Sheet exists.

## Inspiration sources and licences

All components here are original CSS/Tailwind implementations inspired by the sources below; **no
third-party code was copied**. Only public pages were viewed; nothing was signed in to,
downloaded or purchased.

| Source                                                                                                | Used for                                                | Licence / terms                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [shadcn/ui](https://ui.shadcn.com)                                                                    | Component APIs, variant names, CSS-variable naming      | MIT                                                                                                                                                                                                                                                |
| [Aceternity UI](https://ui.aceternity.com)                                                            | Spotlight card, grid/beam backgrounds (ideas)           | Free to use in end products; redistribution as a component library not allowed. Nothing copied.                                                                                                                                                    |
| [Animate UI](https://animate-ui.com)                                                                  | Number ticker, shimmer (ideas)                          | GitHub reports a custom (non-SPDX) licence; not verified as permissive, so nothing copied.                                                                                                                                                         |
| [21st.dev](https://21st.dev)                                                                          | Gradient border and shimmer button patterns             | Licence varies per community component; nothing copied.                                                                                                                                                                                            |
| [Watermelon UI](https://ui.watermelon.sh)                                                             | Card/badge styling ideas                                | Open source; `WatermelonCorp/watermelon-platform` repo is MIT. Nothing copied; motion-based items are on the follow-up list.                                                                                                                       |
| [shaders.com](https://shaders.com)                                                                    | Future WebGPU background                                | `shaders` package MIT; Pro tools paid. Not installed.                                                                                                                                                                                              |
| [ls.graphics](https://www.ls.graphics)                                                                | Candidate device mockups for README / store screenshots | Free mockups allow commercial use but no redistribution; downloads require sign-in, so **nothing downloaded and no binaries added**. Candidates: free MacBook/browser and iPhone mockups from the "Free" section, for the owner to fetch manually. |
| [Mobbin](https://mobbin.com), [Page Flows](https://pageflows.com), [Land-book](https://land-book.com) | Layout references (sidebar, top bar, cards grid, auth)  | Reference only; no assets used.                                                                                                                                                                                                                    |
