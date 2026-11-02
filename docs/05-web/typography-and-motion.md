# Typography, spacing, scrolling and motion

Status: implemented in `apps/web` (branch `feat/typography-motion`). Brand colours and surfaces
live in [brand-theme.md](./brand-theme.md); this doc covers type, layout rhythm, scrolling and
motion. Mobile (Expo) and desktop lanes should copy the values here verbatim.

## 1. Font choice

### Requirements

MeetOps is a dense, dark-first SaaS dashboard. Its main content is meeting lists, transcripts,
timestamps, action items, KPIs and forms. A font has to:

1. carry an OFL (or equivalent) licence that allows commercial use, **self-hosting, subsetting and
   committing the files to the repo**;
2. stay legible at 12–14px, light on dark (`#F5F5F7` on `#0A0A0A`);
3. have **tabular numerals** (`tnum`) so timers and tables don't jitter;
4. ship as a variable font (one file for every weight);
5. be small after Latin subsetting;
6. cover many languages for transcripts and names;
7. be proven in comparable products.

### Candidates (checked 2026-10-25)

| Font                     | Licence                           | Variable axes            | tnum | Latin woff2 (Google Fonts subset) | Coverage                                      | Seen in production                                 |
| ------------------------ | --------------------------------- | ------------------------ | ---- | --------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| **Inter 4.1**            | OFL 1.1, no Reserved Font Name    | wght 100–900, opsz 14–32 | ✅   | ~48 KB (ours: 57 KB incl. extras) | 2,000+ glyphs, 147 languages, Latin/Greek/Cyr | Linear, Notion, Cal.com, Fireflies.ai (meeting AI) |
| Geist                    | OFL 1.1                           | wght 100–900             | ✅   | ~29 KB                            | Latin, Cyrillic (smaller set)                 | Vercel                                             |
| Plus Jakarta Sans        | OFL 1.1                           | wght 200–800             | ✅   | ~27 KB                            | Latin + Latin-ext, Vietnamese                 | marketing sites                                    |
| Manrope                  | OFL 1.1                           | wght 200–800             | ✅   | ~25 KB                            | Latin, Cyrillic, Greek                        | marketing sites                                    |
| Satoshi / General Sans   | ITF Free Font License (Fontshare) | wght (variable)          | ✅   | n/a                               | Latin                                         | startups                                           |
| **JetBrains Mono 2.304** | OFL 1.1, no Reserved Font Name    | wght 100–800             | mono | ~40 KB                            | 150+ languages                                | JetBrains IDEs, many dev tools                     |
| Geist Mono               | OFL 1.1                           | wght 100–900             | mono | ~23 KB                            | Latin, Cyrillic                               | Vercel                                             |

Notes:

- **Satoshi and General Sans are rejected.** The ITF FFL allows free commercial use, but it does
  not allow modifying (subsetting) or redistributing the files, so we can't commit a subset to a
  repo.
- Plus Jakarta Sans and Manrope look good large but have rounder, wider shapes and weaker
  small-size hinting. They lack Inter's screen tuning, and their `cv`/`ss` options for
  disambiguating `Il1` / `0O` are thinner.
- Geist is the closest alternative. It is smaller, but it covers fewer languages and is tightly
  associated with Vercel's brand.
- Otter.ai uses Circular, a commercial font with no OFL option, so it is not a candidate.

### Decision

- **Sans: Inter (variable).**
  - It is designed for computer screens: tall x-height, open apertures, and spacing tuned for
    12–16px.
  - It has `tnum`, slashed zero (`zero`), and `cv11` (single-storey a), plus `ss01` (open digits).
  - It covers 147 languages, which matters for transcripts and attendee names.
  - It is the de-facto SaaS UI face (Linear, Notion, Cal.com, Fireflies), so it reads as
    "professional tool" without looking generic once paired with our rose/cerulean brand.
- **Mono: JetBrains Mono (variable).**
  - Its high x-height (~0.55 em) and clear `0/O`, `1/l/I` make it the most legible mono at
    12–13px.
  - It is used for timecodes, IDs, API keys (masked), and code/kbd.

We self-host both. There is no Google Fonts CDN (privacy, CSP, offline desktop app) and no npm font
package, so no dependency or lockfile change was needed.

### Files and budget

| File (`apps/web/public/fonts`) | Bytes               | Loaded                        | How it was made                                                     |
| ------------------------------ | ------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `InterVariable-latin.woff2`    | 58,128              | **preloaded**                 | official `InterVariable.woff2`, `opsz` pinned to 14 (−33 KB), Latin |
| `JetBrainsMono-latin.woff2`    | 40,372              | lazily on first use           | official `JetBrainsMono[wght].ttf` v2.304, Latin                    |
| **Total**                      | 98,500 (≈ 96.2 KiB) | 56.8 KiB on the critical path |                                                                     |

- The exact commands, the source URLs and sha256 hashes are in `apps/web/public/fonts/README.md`.
- The licence texts are `OFL-Inter.txt` and `OFL-JetBrainsMono.txt`.
- A unit test fails if the Inter file grows past 64,000 B.
- The `unicode-range` is the Google Fonts "latin" range. Characters outside it fall back to the
  system stack. Add `latin-ext` (another ~25 KB, not preloaded) when non-English workspaces need it.

### Loading

- `@font-face` uses `font-display: swap` plus the Latin `unicode-range` (`src/index.css`).
- `index.html` has **one** added line:
  `<link rel="preload" href="/fonts/InterVariable-latin.woff2" as="font" crossorigin />`.
  `crossorigin` is required for font preloads, even same-origin.
- An `Inter Fallback` face is defined from local Arial / Liberation Sans / Helvetica with
  `size-adjust: 104.68%`, `ascent-override: 92.54%`, `descent-override: 23.04%` and
  `line-gap-override: 0%`. This keeps the swap from shifting layout (CLS ≈ 0).
- `html` sets `font-feature-settings: 'cv11', 'calt'` (single-storey a, contextual alternates).

## 2. Type scale

Base size: 14px body (`text-body`) for app UI and 16px (`text-body-lg`) for reading surfaces. Use
these semantic Tailwind classes instead of `text-sm`/`text-2xl` in new code. Each one sets size,
line-height, tracking and (for headings) weight.

| Token           | Size                                                 | Line height | Tracking | Weight | Use                                     |
| --------------- | ---------------------------------------------------- | ----------- | -------- | ------ | --------------------------------------- |
| `text-display`  | `clamp(2.25rem, 1.6rem + 2.6vw, 3.75rem)` (36→60px)  | 1.1         | −0.025em | 700    | auth hero, marketing, empty-state hero  |
| `text-h1`       | `clamp(1.875rem, 1.6rem + 1.1vw, 2.25rem)` (30→36px) | 1.2         | −0.02em  | 600    | page title (one per page)               |
| `text-h2`       | `clamp(1.5rem, 1.35rem + 0.6vw, 1.875rem)` (24→30px) | 1.25        | −0.015em | 600    | major section                           |
| `text-h3`       | 20px                                                 | 28px        | −0.01em  | 600    | dialog titles, sub-sections             |
| `text-h4`       | 18px                                                 | 26px        | −0.005em | 600    | `SectionHeader` (h2), card titles       |
| `text-h5`       | 16px                                                 | 24px        | 0        | 600    | `SectionHeader as="h3"`, list group     |
| `text-h6`       | 14px                                                 | 20px        | 0        | 600    | form-section labels, table group header |
| `text-body-lg`  | 16px                                                 | 26px        | 0        | 400    | summaries, transcripts, docs            |
| `text-body`     | 14px                                                 | 22px        | 0        | 400    | default UI text (set on `body`)         |
| `text-small`    | 13px                                                 | 20px        | 0        | 400    | helper text, table compact, meta        |
| `text-caption`  | 12px                                                 | 16px        | 0.005em  | 400    | timestamps, footnotes, chart labels     |
| `text-overline` | 12px, `uppercase`                                    | 16px        | 0.08em   | 600    | eyebrow above a title, group labels     |

Rules:

- `h1`–`h6` get their scale token and `text-wrap: balance` globally. Paragraphs get
  `text-wrap: pretty`.
- Use **one `h1` per page** and don't skip levels. Pick the visual size with the token, not by
  choosing a different element.
- Use weights 400/500/600/700 only. 500 is for buttons, tabs and nav; 600 for headings; 700 for
  display only.
- Negative tracking is only for ≥ 18px. Small text is never tracked tighter than 0.
- Don't use type smaller than 12px.
- `cn()` (`src/lib/utils.ts`) is configured with `extendTailwindMerge`. As a result
  `cn('text-h1', 'text-foreground')` keeps both classes, and two size tokens still override each
  other.

### Heading patterns (`src/components/ui/typography.tsx`)

| Component       | Markup                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageHeader`    | optional `Overline` eyebrow → `h1.text-h1` → `p.text-body.text-muted-foreground.measure` → actions on the right (wrap below on mobile); `mb-8`    |
| `SectionHeader` | `h2.text-h4` (or `as="h3"` → `text-h5`) + optional description `text-small` muted + actions                                                       |
| Card title      | `<CardTitle className="text-h4">` (the default is left unchanged to avoid churn in feature lanes); description `text-small text-muted-foreground` |
| `Overline`      | `text-overline uppercase`, tone `muted` (default) / `link` / `highlight` (rose, sparingly)                                                        |
| `Timecode`      | `<time dateTime="PT…S" class="timecode">`, using `formatTimecode()` → `m:ss` / `h:mm:ss`                                                          |

`PageHeader` is still re-exported from `src/pages/resource-list.tsx`, so existing imports keep
working.

### Text colour usage

| Role                    | Class                                 | Contrast on `#0A0A0A` |
| ----------------------- | ------------------------------------- | --------------------- |
| Headings, primary text  | `text-foreground` (#F5F5F7)           | 18.18:1               |
| Secondary, descriptions | `text-muted-foreground` (#A1A1AA)     | 7.72:1                |
| Links, inline actions   | `text-link` (#3AB0E0)                 | 7.98:1                |
| Live / active accent    | `text-highlight` (rose), ≤ 1 per view | AA large/UI           |
| Destructive             | `text-destructive`                    | AA                    |

Never put long text in muted colour. Never convey state by colour alone; add an icon or a label.

### Line length

- Prose, summaries and transcripts use `.measure` / `max-w-measure` (`--measure: 70ch`), which
  falls inside the 65–75ch target.
- Tables and dashboards are not width-limited. Their container is `max-w-content` (80rem).

### Numbers

- Use `tabular-nums` / `.nums-tabular` for tables, KPIs, counters and pagination.
- Use `.timecode` (mono + `tabular-nums slashed-zero`, no ligatures) for timers, durations and
  transcript timestamps.

## 3. Spacing and layout

All spacing is on the Tailwind **4px** grid. Preferred steps:

| Step | px  | Tailwind | Typical use                                     |
| ---- | --- | -------- | ----------------------------------------------- |
| 1    | 4   | `1`      | icon ↔ text in badges                           |
| 2    | 8   | `2`      | icon ↔ label in buttons, inline gaps            |
| 3    | 12  | `3`      | list-item internal gap, compact cell padding    |
| 4    | 16  | `4`      | form field gap, card grid gap (mobile), gutter  |
| 6    | 24  | `6`      | card padding, card grid gap (≥ sm), gutter ≥ sm |
| 8    | 32  | `8`      | page padding ≥ lg, `PageHeader` bottom margin   |
| 12   | 48  | `12`     | gap between page sections                       |
| 16   | 64  | `16`     | hero / empty-state vertical padding             |

Avoid off-grid values (`5`, `7`, `[13px]`) unless you are aligning to a border.

| Layout token      | Value                                                                      | Where                                              |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Page padding      | `p-4 sm:p-6 lg:p-8` (16/24/32px)                                           | `<main>` in `AppShell`                             |
| Content max width | `max-w-content` = 80rem (1280px), centred                                  | `<main>`                                           |
| Section gap       | `gap-12` / `space-y-12` (48px)                                             | between page sections                              |
| Card padding      | `p-6` (24px), `p-4` on dense cards                                         | `Card*` components                                 |
| Card grid gutter  | `gap-4 sm:gap-6`                                                           | dashboards, lists of cards                         |
| Form fields       | field↔field `gap-4`, label↔control `gap-1.5`, helper `mt-1.5`              | forms                                              |
| Form sections     | `gap-8` + `text-h6` heading                                                | long settings forms                                |
| Header height     | `h-header` = 3.5rem (56px)                                                 | top bar, sidebar brand row                         |
| Sidebar width     | `w-sidebar` = 15rem (240px); collapsed `w-sidebar-collapsed` = 4rem (64px) | `AppShell`                                         |
| Breakpoints       | Tailwind defaults `sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`         | sidebar shows at `lg`; below it the nav is a Sheet |

### Density

| Mode                  | Row height  | Cell padding | Text         | Use                                        |
| --------------------- | ----------- | ------------ | ------------ | ------------------------------------------ |
| Comfortable (default) | `h-12` 48px | `px-4 py-3`  | `text-body`  | meetings, tasks, people tables             |
| Compact               | `h-9` 36px  | `px-3 py-2`  | `text-small` | transcripts index, audit logs, admin lists |

Touch targets stay ≥ 44px on touch devices. Compact mode is a desktop/pointer preference only.

## 4. Scrolling

| Behaviour            | Implementation                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smooth anchor scroll | `html { scroll-behavior: smooth }` **only inside** `@media (prefers-reduced-motion: no-preference)`                                                                       |
| Sticky-header offset | `html { scroll-padding-top: calc(var(--header-height) + 1rem) }`, so anchors land below the top bar                                                                       |
| Dark scrollbars      | `scrollbar-color: hsl(var(--border)) transparent` + thin WebKit thumb (rounded, hover brightens)                                                                          |
| Contained regions    | `.scroll-area`: `overflow:auto`, `overscroll-behavior: contain`, thin, `scrollbar-gutter: stable`. Used for the sidebar nav, transcript panes, popover lists              |
| Edge fades           | `.scroll-fade-y` / `.scroll-fade-x`: static 16px mask, no motion                                                                                                          |
| Snap rows            | `.snap-row`: horizontal `scroll-snap-type: x mandatory`, children `snap-align: start`. Use for chip filters and mobile card carousels, **never** for vertical page scroll |
| Scroll-driven reveal | `.reveal-on-scroll`: `animation-timeline: view()` inside `@supports` + no-preference. Fallback is plain visible content; the base state is never hidden                   |
| Body                 | no global `overscroll-behavior` (keep pull-to-refresh/back gestures); only regions contain                                                                                |

Don't hijack scroll or animate scroll position with JS. Long lists (transcripts) should
virtualise; that is a follow-up and would need a dependency.

## 5. Motion

### Tokens

| Token                | Value                      | Tailwind           | Use                                      |
| -------------------- | -------------------------- | ------------------ | ---------------------------------------- |
| `--duration-instant` | 100ms                      | `duration-instant` | press, exits, tooltips out               |
| `--duration-fast`    | 150ms                      | `duration-fast`    | hover, focus, popover/menu enter         |
| `--duration-base`    | 200ms                      | `duration-base`    | dialogs, toasts, page enter, sidebar     |
| `--duration-slow`    | 300ms                      | `duration-slow`    | large panels/sheets only (max)           |
| `--ease-out`         | `cubic-bezier(.2,.8,.2,1)` | `ease-out`         | anything entering                        |
| `--ease-standard`    | `cubic-bezier(.4,0,.2,1)`  | `ease-standard`    | on-screen changes (resize, move, colour) |
| `--ease-in`          | `cubic-bezier(.4,0,1,1)`   | `ease-in`          | anything leaving                         |

UI motion never runs longer than 300ms. Exits are faster than enters.

### Patterns

| Element                 | Enter                                                                            | Exit                               |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| Popover / menu / select | `animate-enter-up`: fade + 4px rise, 150ms `ease-out`                            | `animate-fade-out` 100ms `ease-in` |
| Tooltip                 | `animate-fade-in` 150ms                                                          | 100ms fade                         |
| Toast                   | `animate-toast-in`: 8px rise + scale .98→1, 200ms                                | fade 150ms                         |
| Dialog                  | overlay fade 200ms; content `enter-up` 200ms `ease-out`                          | 150ms `ease-in` fade               |
| Page (route) change     | `animate-page-in`: fade + 4px rise, 200ms; or View Transition cross-fade         | old view fades 100ms               |
| Hover                   | colour/background `transition-base` 150ms                                        | —                                  |
| Press                   | `active:scale-[.98]` 100ms                                                       | —                                  |
| Skeleton / shimmer      | `.shimmer` sheen 2.2s loop; skeletons only, ≤ 1 shimmer button per view          | hidden under reduced motion        |
| Lists                   | `.stagger` with `style="--i: n"`: 30ms per item, **capped at 6** (≤ 180ms total) | no stagger on exit                 |
| Live indicator          | `animate-live-pulse` (opacity only)                                              | —                                  |

Only animate `opacity` and `transform`. Never animate `width`, `height`, `top` or `left`, apart
from the sidebar collapse, which uses `ease-standard`.

### View Transitions (progressive enhancement)

`::view-transition-old/new(root)` cross-fades are defined in `index.css` (old 100ms out, new
200ms in with a 4px rise). They only run when navigation calls `document.startViewTransition()`.

Wiring that into React Router (`viewTransition` on links/`navigate`) is a **follow-up for the
owner of `routes/router.tsx`**, which this lane does not edit. Browsers without support simply
navigate.

### Reduced motion

Under `@media (prefers-reduced-motion: reduce)`:

- all animations/transitions are cut to 0.01ms with one iteration (state changes still apply,
  they just don't move);
- `scroll-behavior` becomes `auto`;
- View Transition pseudo-elements get `animation: none`;
- `.shimmer` is hidden and the gradient border spin stops;
- `.reveal-on-scroll` never activates, because it is gated on `no-preference`;
- the live dot keeps a static colour.

Never convey meaning through motion alone.

## 6. Mobile (Expo) and desktop parity

- **Mobile (`apps/mobile`, Expo):**
  - Use the same two fonts. Load the static or variable TTFs with `expo-font` (`useFonts`) or the
    `expo-font` config plugin. That is a dependency change, so it goes in the lockfile queue
    (not this PR).
  - React Native doesn't support `clamp()` or `ch`. Use the **fixed sizes** from the table: h1
    30, h2 24, h3 20, h4 18, body 16 on phones (iOS/Android body minimum), small 13, caption 12.
  - Line heights stay the same in px.
  - Set `fontVariant: ['tabular-nums']` for timers.
  - Respect `AccessibilityInfo.isReduceMotionEnabled()` and Dynamic Type (`allowFontScaling`,
    capped with `maxFontSizeMultiplier` ≈ 1.6 on dense rows).
  - Motion durations and easings are identical. Reanimated `Easing.bezier(.2,.8,.2,1)`.
- **Desktop (Electron/Tauri lane):**
  - Bundle the same `woff2` files locally (no network) and reuse `index.css` tokens.
  - Expose a compact-density toggle (section 3).
  - Use native window chrome height = `--header-height`.
- **Extension popup:** keeps the system stack, since the popup budget is tiny. It may adopt Inter
  later by copying the file into `apps/extension/public`.

## 7. Sources

- Inter: https://rsms.me/inter/ · licence https://github.com/rsms/inter/blob/master/LICENSE.txt · features https://rsms.me/inter/#features
- JetBrains Mono: https://www.jetbrains.com/lp/mono/ · https://github.com/JetBrains/JetBrainsMono (OFL, release v2.304)
- Geist / Geist Mono: https://vercel.com/font · https://github.com/vercel/geist-font (OFL)
- Plus Jakarta Sans: https://fonts.google.com/specimen/Plus+Jakarta+Sans · Manrope: https://fonts.google.com/specimen/Manrope
- Satoshi / General Sans licence: https://www.fontshare.com/licenses/itf-ffl
- SIL OFL 1.1: https://openfontlicense.org/
- Production usage, read from public HTML/CSS on 2026-10-25: https://linear.app, https://www.notion.com, https://cal.com, https://fireflies.ai, https://vercel.com, https://otter.ai
- `font-display` / preload: https://web.dev/articles/font-best-practices · fallback metric overrides: https://developer.chrome.com/blog/font-fallbacks
- Line length: https://baymard.com/blog/line-length-readability
- Scroll-driven animations: https://developer.mozilla.org/docs/Web/CSS/animation-timeline/view · View Transitions: https://developer.mozilla.org/docs/Web/API/View_Transition_API
- Reduced motion: https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions
