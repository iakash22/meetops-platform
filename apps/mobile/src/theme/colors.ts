/**
 * MeetOps brand tokens (owner decision, all apps): dark-first, no light theme.
 *
 * Single source of truth for the mobile app; screens must not hard-code hex values.
 * Values and mobile keys mirror docs/05-web/brand-theme.md (web theme lane) verbatim. Names follow
 * shadcn semantics so they line up with the web CSS variables:
 *
 * | mobile key                 | web variable                         |
 * | -------------------------- | ------------------------------------ |
 * | background / foreground    | --background / --foreground          |
 * | card (surface 1)           | --card, --muted                      |
 * | secondary (surface 2)      | --popover, --secondary, --accent     |
 * | accent (Neon Rose)         | --highlight (web `accent` is neutral)|
 * | destructive                | --destructive                        |
 */
export const colors = {
  /** Jet Black: app background. */
  background: '#0A0A0A',
  /** Body text (18.2:1 on background). */
  foreground: '#F5F5F7',
  /** Surface 1: cards, tab bar, list rows. */
  card: '#141416',
  cardForeground: '#F5F5F7',
  /** Web --muted (same value as card). */
  muted: '#141416',
  /** Surface 2: pressed/selected rows, secondary fills, skeletons. */
  secondary: '#1C1C1F',
  secondaryForeground: '#F5F5F7',
  /** Web --popover (same value as secondary): sheets, menus. */
  popover: '#1C1C1F',
  /** Secondary text and placeholders (AA on every surface). */
  mutedForeground: '#A1A1AA',
  /** Decorative 1px dividers and card borders. */
  border: '#2A2A2E',
  /** Form-control borders (>= 3:1 against the background). */
  input: '#6B6B73',
  /** Cerulean Blue: primary fills. Not for text on dark (4.14:1); use `link`. */
  primary: '#007BA7',
  primaryPressed: '#00698F',
  /** Text on primary (4.78:1). */
  primaryForeground: '#FFFFFF',
  /** Cerulean text and links on dark (7.98:1). */
  link: '#3AB0E0',
  /** Focus rings. */
  ring: '#3AB0E0',
  /** Neon Rose (web `--highlight`): active tab, live/recording states, record button. Sparingly. */
  accent: '#FF2D95',
  /** Text on rose fills (white would fail AA). */
  accentForeground: '#0A0A0A',
  /** Errors and danger. Red, deliberately distinct from rose (5.26:1 as text on background). */
  destructive: '#EF4444',
  /** Inline error text (field errors, toasts): lighter red for comfortable AA at small sizes. */
  destructiveText: '#F87171',
  /** Text on destructive fills (white would fail AA). */
  destructiveForeground: '#0A0A0A',
  /** Warnings. */
  warning: '#F5A524',
} as const;

export type ColorToken = keyof typeof colors;

/** Corner radius (web `--radius` 0.75rem): md for buttons/inputs, lg for cards, xl for hero cards. */
export const radius = { sm: 6, md: 8, lg: 12, xl: 16, full: 999 } as const;

/** Spacing scale: generous by default (4-pt grid). */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Glow (brand elements only), matching web `0 0 12px rgba(…)` values. */
export const glow = {
  primary: { color: '#007BA7', opacity: 0.45, radius: 12 },
  accent: { color: '#FF2D95', opacity: 0.35, radius: 12 },
} as const;

/** Motion durations (web --duration-fast / --duration-base). */
export const motion = { fast: 150, base: 200 } as const;
