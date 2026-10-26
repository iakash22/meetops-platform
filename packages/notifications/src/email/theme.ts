/**
 * Email brand tokens. Mirrors docs/references.md section 1 and docs/05-web/brand-theme.md.
 * Dark-first: #0A0A0A background. Cerulean #007BA7 is a FILL only (CTA buttons, accent rules), never text on
 * black. Links and cerulean-coloured text use #3AB0E0. Rose is not used in email (no live/record state).
 * Every text/background pair below is checked for WCAG AA (>= 4.5:1) in test/email-theme.test.ts.
 */
export const emailTheme = {
  /** Values match apps/web/src/index.css tokens (background, card, popover, border, foreground...). */
  background: '#0A0A0A',
  surface: '#141416',
  surfaceRaised: '#1C1C1F',
  border: '#2A2A2E',
  text: '#F5F5F7',
  muted: '#A1A1AA',
  primaryFill: '#007BA7',
  onPrimary: '#FFFFFF',
  link: '#3AB0E0',
  /** Cerulean-tinted chip/tile background; #3AB0E0 text on it stays AA. */
  primaryTint: '#0B2531',
  destructive: '#EF4444',
  destructiveText: '#F87171',
  destructiveTint: '#2A1215',
  /** Light fallback for clients that force a light scheme (prefers-color-scheme: light). */
  light: {
    background: '#FFFFFF',
    surface: '#F5F5F7',
    border: '#D4D4D8',
    text: '#111113',
    muted: '#52525B',
    link: '#005F82',
    destructive: '#B91C1C',
  },
  /** Inter is the web font (self-hosted); email clients mostly fall back to the system stack. */
  fontStack:
    "InterVariable,Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  monoStack: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  radius: { sm: 6, md: 8, lg: 12, xl: 16 },
} as const;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.1 contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
