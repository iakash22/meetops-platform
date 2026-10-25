/**
 * MeetOps brand tokens (owner decision, all apps): dark-first.
 *
 * Single source of truth for the mobile app; screens must not hard-code hex values.
 * Names follow shadcn/ui semantics (background/foreground, card, primary, accent, muted,
 * border, input, ring, radius) so they line up with the web theme variables.
 */
export const colors = {
  /** Jet Black: app background. */
  background: '#0A0A0A',
  foreground: '#F5F5F7',
  /** Raised surfaces: cards, inputs, list rows. */
  card: '#141416',
  cardForeground: '#F5F5F7',
  /** Second surface level: pressed rows, sheets, subtle fills. */
  muted: '#1C1C1F',
  mutedForeground: '#A1A1AA',
  border: '#2A2A2E',
  input: '#2A2A2E',
  /** Cerulean Blue: buttons, links, focus. */
  primary: '#007BA7',
  primaryForeground: '#F5F5F7',
  /** Neon Rose: highlights, active/live states, record button. Use sparingly. */
  accent: '#FF2D95',
  accentForeground: '#0A0A0A',
  /** Focus ring (primary). */
  ring: '#007BA7',
  /**
   * Validation and error text. The palette has no separate red, so this reuses Neon Rose
   * (owner question: confirm or supply a destructive colour).
   */
  destructive: '#FF2D95',
} as const;

export type ColorToken = keyof typeof colors;

/** Corner radius scale; `radius.md` is the base (shadcn `--radius`). */
export const radius = { sm: 6, md: 10, lg: 14, full: 999 } as const;

/** Spacing scale: generous by default (4-pt grid). */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
