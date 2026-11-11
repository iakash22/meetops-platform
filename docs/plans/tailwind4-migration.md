# Plan: migrate apps/web to Tailwind CSS 4 (RE-01)

Status: proposal. Owner: Web, with DevOps for the lockfile slot and the audit gate.
Baseline: `integration/phase-1` @ `e4aceac` (merge of #342, 31 Oct 2026 20:49 IST).
Risk exception: RE-01 (`braces@3.0.3`, GHSA-vfj7-8cjw-p6xm) is **closed** (advisory withdrawn 2026-10-23; gate row
removed, see `docs/12-security/risk-exceptions.md`). This plan no longer has a deadline. Version and advisory facts below were checked against the npm registry, the GitHub
Advisory Database and the Tailwind v4 upgrade guide on 1 Nov 2026 (IST).

## 0. Summary

- **RE-01 no longer depends on this migration.** GitHub **withdrew** GHSA-vfj7-8cjw-p6xm on 23 Oct 2026 ("not a
  practically exploitable vulnerability"). `pnpm audit` on the baseline returns no `braces` finding, so the RE-01 row
  in the gate is dormant. Remove it in a docs + gate PR (no lockfile change). `braces` 3.0.3 is still the latest version.
- Even if the advisory were live, Tailwind 4 alone would not clear it. `braces@3.0.3` has 23 lockfile paths, including
  mobile (`@expo/cli`, `jest`, RN codegen), the extension (`wxt` → `unimport` → `fast-glob`) and root `lint-staged@15`.
  The CO-7 acceptance line "RE-01 removed after Tailwind 4" should be reworded.
- Tailwind 4 is still worth doing as dependency hygiene:
  - it removes `tailwindcss@3.4.19` → `chokidar@3` / `postcss-selector-parser@6`;
  - it matches `apps/desktop`, which already uses `tailwindcss ^4.3.3` and `@tailwindcss/vite`;
  - it shrinks the PostCSS toolchain.
    It is D4 in the lockfile queue, with **no deadline**. Expo SDK 55 (RE-04, 24 Nov) should take the slot first; see
    `docs/plans/expo-rn-upgrade.md`.
- Target: `tailwindcss ^4.3.3` and `@tailwindcss/vite ^4.3.3`, with `tw-animate-css ^1.4.0` replacing
  `tailwindcss-animate`. Remove `postcss`, `autoprefixer`, `postcss.config.js` and `tailwind.config.ts` from
  `apps/web`. Estimate about 2–3 engineer-days.

## 1. Inventory (baseline)

| Item                                                | Today                                                        | After                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `tailwindcss`                                       | `^3.4.14` (resolves 3.4.19)                                  | `^4.3.3` (latest, 2026-07-16; already in the lockfile through `apps/desktop`)                               |
| Build integration                                   | `postcss.config.js`: `{ tailwindcss: {}, autoprefixer: {} }` | `@tailwindcss/vite ^4.3.3` in `vite.config.ts` (peer `vite ^5.2 \|\| ^6 \|\| ^7 \|\| ^8`; web has `^7.3.7`) |
| `postcss`, `autoprefixer`                           | `^8.4.47`, `^10.4.20`                                        | removed (v4 does imports and vendor prefixing itself through Lightning CSS)                                 |
| Animations plugin                                   | `tailwindcss-animate ^1.0.7` (`plugins: [animate]`)          | `tw-animate-css ^1.4.0` (`@import 'tw-animate-css'`)                                                        |
| Config                                              | `tailwind.config.ts` (`darkMode: ['class']`, `theme.extend`) | deleted. Tokens move to `@theme` in `src/index.css`                                                         |
| `tailwind-merge`                                    | `^3.7.0`                                                     | unchanged (3.x targets v4). Keep the `extendTailwindMerge` font-size group in `src/lib/utils.ts`            |
| shadcn `components.json`                            | `"tailwind": { "config": "tailwind.config.ts", ... }`        | `"config": ""`                                                                                              |
| `tsconfig.json` include, `eslint.config.mjs` ignore | list `tailwind.config.ts` / `postcss.config.js`              | remove those entries                                                                                        |
| `docs/05-web/brand-theme.md` line 58                | points at `tailwind.config.ts`                               | point at `src/index.css` `@theme`                                                                           |

Browser floor: v4 targets Safari 16.4+, Chrome 111+ and Firefox 128+ (it needs `@property` and `color-mix()`). The web
build already targets `es2022`. Confirm with the product owner that this floor is acceptable.

## 2. Config → CSS `@theme` (brand tokens kept)

The brand is dark-first. `index.html` sets `<html class="dark">` and `:root` holds the dark palette as HSL channels.
Keep those channel variables exactly as they are, so shadcn components and any `hsl(var(--x) / a)` CSS keep working,
and map them into Tailwind's namespaces with `@theme inline`:

| Brand token (docs/05-web/brand-theme.md) | CSS variable (unchanged)                             | Utility namespace                            |
| ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Background **#0A0A0A** (Jet Black)       | `--background: 0 0% 3.9%`                            | `--color-background: hsl(var(--background))` |
| Primary **#007BA7** (Cerulean Blue)      | `--primary: 195.8 100% 32.7%`                        | `--color-primary: hsl(var(--primary))`       |
| Accent **#FF2D95** (Neon Rose)           | `--highlight: 330.3 100% 58.8%`                      | `--color-highlight: hsl(var(--highlight))`   |
| shadcn neutral accent #1C1C1F            | `--accent` (shadcn naming, **not** the brand accent) | `--color-accent: hsl(var(--accent))`         |

The brand accent #FF2D95 is called `highlight` in code because shadcn already uses `accent` for the hover surface.
**Do not rename it** during the migration, or every `bg-accent` hover changes colour.

Sketch of the new top of `src/index.css`. The full list of colours is the same as `tailwind.config.ts` today: border,
input, ring, background, foreground, primary, secondary, destructive (+text), warning (+text), muted, accent, card,
popover, highlight and link, each with its `-foreground`.

```css
@import 'tailwindcss';
@import 'tw-animate-css';

@custom-variant dark (&:where(.dark, .dark *));

@theme inline {
  --color-background: hsl(var(--background));
  --color-primary: hsl(var(--primary));
  --color-primary-foreground: hsl(var(--primary-foreground));
  --color-highlight: hsl(var(--highlight));
  /* ...the rest of the colours, one line each... */

  --radius-xl: calc(var(--radius) + 4px);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 4px);
  --radius-sm: calc(var(--radius) - 6px);

  --spacing-header: var(--header-height); /* h-header */
  --spacing-sidebar: var(--sidebar-width); /* w-sidebar */
  --spacing-sidebar-collapsed: var(--sidebar-width-collapsed);
  --container-measure: var(--measure); /* max-w-measure */
  --container-content: var(--content-max); /* max-w-content */
}

@theme {
  /* Same names as Tailwind's defaults: give the literal value here, not var(--same-name) */
  --font-sans:  /* the stack from :root --font-sans today *;
  --font-mono:  /* the stack from :root --font-mono today *;
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
  --default-transition-duration: 150ms;
  --default-transition-timing-function: var(--ease-standard);

  --text-h1: clamp(/* as today */);
  --text-h1--line-height:  /* as today *;
  --text-h1--letter-spacing:  /* as today *;
  --text-h1--font-weight:  /* as today *;
  /* display, h2–h6, body-lg, body, small, caption, overline: same pattern */

  --animate-live-pulse: live-pulse /* duration, easing, iteration as today */;
  /* toast-in, fade-in, fade-out, enter-up, exit-down, page-in: same pattern */
  @keyframes live-pulse {
    /* as today */
  }
}

@utility duration-instant {
  transition-duration: var(--duration-instant);
}
/* duration-fast, duration-base, duration-slow: same */
```

Notes:

- Copy the variable names in the sketch (`--header-height`, `--sidebar-width`, `--measure`, `--content-max`, …) from the current
  `tailwind.config.ts`. They are placeholders. Copy the font stacks and the `clamp()` values exactly; do not retype them.
- **Name collisions.** `--font-sans`, `--font-mono`, `--ease-out`, `--ease-in` and `--radius` already exist in
  Tailwind's default theme. `apps/desktop` writes `--font-sans: var(--font-sans)` inside `@theme inline`. That only
  works because our `@layer base :root` wins over `@layer theme`, and it breaks the moment the declaration moves. For
  web, put the literal value in `@theme` once and delete the duplicate from `:root`. Keep raw `var(--ease-out)` uses in
  `index.css` working with `@theme static`, or keep a `:root` copy that has the same value.
- **`--radius`.** shadcn's `--radius: 0.75rem` also overrides Tailwind's `--radius` (0.25rem), which the bare
  `rounded` utility reads. Our one bare `rounded` (`features/search/search-page.tsx:33`, the `<mark>`) would grow from
  4px to 12px. Change it to `rounded-[4px]`.
- The type scale has to be a `--text-*` theme variable, not `@utility`. That way `text-h1` stays in Tailwind's
  font-size group and the `@apply text-h1…h6` / `text-body` rules in `@layer base` keep working.
- `duration-*` has no theme namespace in v4, so the four named durations become `@utility` (as desktop does). Only
  `duration-base` is used in components today.
- Keep `* { @apply border-border; }` in `@layer base`. It keeps the v3 behaviour of a brand-coloured default border
  (v4 defaults to `currentColor`). It also covers the 60 bare `border` uses (32 files) and the 12 `divide-y` uses.
- `@layer utilities` custom classes (brand-glow, surface-glass, bg-grid, gradient-border, shimmer, timecode,
  nums-tabular, measure, scroll-area, scroll-fade-x/y, snap-row, stagger, transition-base):
  - convert the single-class ones to `@utility name { ... }`;
  - move the ones with child or pseudo selectors (`.snap-row > *`, `.stagger > *`, `.shimmer::after`) to plain CSS in
    `@layer components`.
    None of them is used with a variant today (checked with `rg`), so nothing else depends on how they are registered.

## 3. PostCSS → Vite plugin

```ts
// apps/web/vite.config.ts
import tailwindcss from '@tailwindcss/vite';
// ...
plugins: [react(), tailwindcss(), apiPreconnect(viteApiUrl)],
```

- Then delete `postcss.config.js` and remove `postcss`, `autoprefixer`, `tailwindcss-animate` from `apps/web/package.json`.
- Vitest runs with `css: false`, so tests do not load the plugin's output.
- `@tailwindcss/vite` depends on `@tailwindcss/oxide` (native binaries) and `@tailwindcss/node` (which pulls in `lightningcss`). Both are already
  in the lockfile through desktop, so the lockfile diff should be small. Check the CI image still installs the
  `linux-x64-gnu` optional binaries (desktop CI already does).

## 4. Class renames found by grep (apps/web/src at `e4aceac`)

| v3 class in our code                                                    | Count / where                                                                                                                                                 | v4 action                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outline-none` (mostly `focus-visible:outline-none`)                    | 27 in 21 files (`components/ui/*`, forms)                                                                                                                     | → `outline-hidden` (v4 `outline-none` really removes the outline, which hurts forced-colors mode)                                                                          |
| `backdrop-blur-sm`                                                      | 1, `components/ui/dialog.tsx:20` (overlay)                                                                                                                    | → `backdrop-blur-xs` (4px in both versions). `backdrop-blur-md` (1) stays.                                                                                                 |
| `max-h-[--radix-select-content-available-height]`                       | 1, `components/ui/select.tsx:69`                                                                                                                              | → `max-h-(--radix-select-content-available-height)`                                                                                                                        |
| `rounded-sm`                                                            | 3: `features/auth/styles.ts:7`, `components/ui/select.tsx:112`, `components/ui/toast.tsx:120`                                                                 | **Keep.** Our `--radius-sm` is custom (`calc(var(--radius) - 6px)`). Revert the upgrade tool's `rounded-xs` rename.                                                        |
| `rounded` (bare)                                                        | 1, `features/search/search-page.tsx:33`                                                                                                                       | → `rounded-[4px]` (see `--radius` note in §2)                                                                                                                              |
| `transition-[color,background-color,border-color,box-shadow,transform]` | 1, `components/ui/button.tsx:8`                                                                                                                               | v4 scale/translate use their own properties, so `transform` no longer animates them. Button has no scale or translate today: drop `transform`, or write `translate,scale`. |
| `dark:` variant                                                         | 1, `components/ui/alert.tsx:13` (`dark:border-destructive/60`)                                                                                                | Keep, with `@custom-variant dark (&:where(.dark, .dark *))` (v4 defaults to `prefers-color-scheme`)                                                                        |
| tailwindcss-animate classes                                             | 12 in ~6 files (`sheet`, `dialog`, `select`, `toast`, `auth-layout.tsx:50`): `animate-in/out`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`, `slide-out-to-*` | Same names in `tw-animate-css`. Check the open and close animations visually.                                                                                              |
| `shadow-*`, `ring-*`                                                    | `shadow-lg` ×4, arbitrary shadows. `ring-2` ×21, `ring-1`, `ring-4`, `ring-offset-*`, `ring-ring` ×21                                                         | No change. No bare `shadow`, `shadow-sm`, `ring` or `blur` in use.                                                                                                         |

Not used, so no work (checked with `rg`):

- the `!` important prefix and `theme()`;
- `*-opacity-*`, `flex-shrink-*`/`flex-grow-*`, `overflow-ellipsis`;
- `container`, `bg-gradient-to-*`, `transform-none`;
- stacked `*:` variants and comma-separated `grid-cols-[...]`.

Behaviour changes with no rename that still need a visual check:

- `space-y-*` (44 uses in 20 files) and `divide-y` (12 in 10 files) now use a `:not(:last-child)` selector. Check
  forms and lists that mix them with conditional children or margins.
- `hover:` applies only on hover-capable devices (40 uses in 23 files). That is fine for desktop. Check that touch
  layouts do not rely on hover.
- Buttons get `cursor: default` (v4 Preflight). `Button` has no `cursor-pointer`. Add the base rule from the upgrade
  guide (`button:not(:disabled), [role='button']:not(:disabled) { cursor: pointer; }`) to keep today's feel.
- Placeholder colour becomes the current text at 50%. Inputs and textareas set `placeholder:text-muted-foreground`
  explicitly, so there is no change.
- `transition` now includes `outline-color` (`motion-safe:transition`, 3 files including `sheet.tsx:31`).
- The `hidden` attribute now beats display classes. We use none (checked with `rg`; only `aria-hidden`).

Using the upgrade tool: `pnpm dlx @tailwindcss/upgrade@4.3.3` on a branch is fine for the mechanical renames. It needs
Node 20+, which we have. Review its diff by hand: it **will** wrongly rename our custom `rounded-sm` (and `rounded`),
and it cannot know `--highlight` is the brand accent.

## 5. Impact on shadcn `components/ui`

Files: alert, badge, button, card, dialog, input, label, number-ticker, select, separator, sheet, skeleton,
spotlight-card, tabs, textarea, toast, typography.

- Mechanical edits: `outline-hidden` (most files), `select.tsx` CSS-var syntax, `dialog.tsx` backdrop blur,
  `button.tsx` transition list.
- Keep our HSL channel tokens rather than adopting shadcn's v4 OKLCH palette. A palette change would be a brand change
  and needs a separate review against `docs/05-web/brand-theme.md`.
- `components.json` gets `"config": ""` so future `shadcn add` commands generate v4 classes. New components from the
  v4 registry use `data-slot` attributes and `outline-hidden`/`ring-[3px]`. Review them against our ring tokens
  (`ring-ring`, `ring-offset-background`) when they are added.
- `test/textarea.test.tsx:27` asserts the class strings `bg-card`, `border-input`, `focus-visible:ring-ring/40` and
  `max-h-40`. None of them changes in v4, so the test should pass unchanged.

## 6. Verification

1. `pnpm --filter @meetops/web lint typecheck test build` (turbo `--concurrency=2`).
2. `node apps/web/scripts/check-bundle-size.mjs`. The CSS budget is **8 kB gzip**. v4 adds `@property` rules and
   theme variables. If it goes over, set `@theme` variables to `static` only where raw CSS needs them, and report the
   delta in the PR rather than silently raising the budget.
3. Compiled CSS checks: grep `dist/assets/*.css` for:
   - `--color-primary` resolving to `hsl(var(--primary))`;
   - `.dark` scoping on `dark:` rules;
   - `.outline-hidden`;
   - `animate-in` keyframes;
   - **no** `@tailwind` directives.
4. Visual pass in the dev server (`index.html class="dark"`). Compare before and after screenshots of:
   - auth (login, signup, password strength), app shell (sidebar open and collapsed, header), meetings list and
     detail, search (`<mark>` radius), members/teams, settings;
   - the dialog, sheet, select, toast and tabs open/close animations, and focus rings by keyboard;
   - the brand glow (`brand-glow`, `--glow-*`), `bg-grid` and `gradient-border`.
     Check the computed colours: background `#0A0A0A`, primary fill `#007BA7`, highlight `#FF2D95`, link and ring
     `#3AB0E0`.
5. `pnpm why braces` and `pnpm why tailwindcss`: no `tailwindcss@3` left in `apps/web`. `braces` remains through
   mobile, extension and lint-staged; that is expected and not an advisory any more.
6. `gitleaks` over the branch.

## 7. Lockfile sequencing

- **Lockfile PR (D4), one at a time:** `apps/web/package.json` (add `@tailwindcss/vite`, `tw-animate-css`, bump
  `tailwindcss`; drop `postcss`, `autoprefixer`, `tailwindcss-animate`) plus `pnpm-lock.yaml`, all in one PR with the
  CSS and class changes. Running `pnpm install` from the root should touch only the `apps/web` importer and the
  removed v3 subtree. **Do not regenerate the lockfile wholesale.**
- Proposed slot: **after** the Expo SDK 55 PR (RE-04 has the hard date). Before Expo is fine only if the coordinator
  confirms the Expo PR cannot start before about 8 Nov anyway.
- Separate, not a lockfile change, can go now: a docs + gate PR that deletes the RE-01 row from
  `scripts/audit-gate.mjs` and marks RE-01 "closed: advisory withdrawn 2026-10-23" in
  `docs/12-security/risk-exceptions.md`. It needs a Security owner sign-off.
- Optional, later: root `lint-staged` `^15.2.10` → `^16.4.0` (Node >= 20.17; 17.x needs Node 22.22.1) drops one
  `micromatch` → `braces` path. That is a root lockfile change, so it gets its own slot.

## 8. Rollback

- Before merge: close the PR.
- After merge: `git revert -m 1 <merge-sha>` (a plain revert, no force push). This restores `tailwind.config.ts`,
  `postcss.config.js`, `package.json` and `pnpm-lock.yaml` together. The revert is itself a lockfile PR, so tell the
  coordinator. Nothing else depends on v4 in `apps/web`. Desktop keeps its own v4.
- RE-01 is unaffected either way. Its advisory is withdrawn, so a revert does not reopen a gate failure.

## 9. Estimate

| Work                                                              | Engineer-days |
| ----------------------------------------------------------------- | ------------- |
| `@theme` migration of tokens, type scale, animations; Vite plugin | 0.75          |
| Class renames and shadcn edits (§4/§5), tool diff review          | 0.5           |
| Visual pass, bundle budget, fixes (`space-y`, cursor, animations) | 0.75–1.25     |
| Docs (`brand-theme.md`, `components.json`), review rounds         | 0.25–0.5      |
| **Total**                                                         | **2.25–3**    |

## 10. Risks

| Risk                                                          | Mitigation                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Silent visual drift (radius, spacing, cursor, hover on touch) | Before/after screenshots of the pages listed in §6; the `--radius`/`rounded` and `cursor` fixes in §2/§4 |
| CSS over the 8 kB gzip budget                                 | Measure first. Trim unused theme vars (`@theme` only emits used vars by default).                        |
| Upgrade tool renames our custom radius classes                | Keep `rounded-sm` as is. Review the tool's diff line by line.                                            |
| Older browsers lose styles (`color-mix`, `@property`)         | Confirm the browser floor (§1) before merging.                                                           |
