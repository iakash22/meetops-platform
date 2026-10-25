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
