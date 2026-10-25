import { colors } from '../src/theme/colors';

/** Mirrors docs/05-web/brand-theme.md (web theme lane). Keep in sync. */
describe('brand palette (dark-first)', () => {
  it('matches the owner-approved tokens shared with web', () => {
    expect(colors).toMatchObject({
      background: '#0A0A0A',
      foreground: '#F5F5F7',
      card: '#141416',
      muted: '#141416',
      secondary: '#1C1C1F',
      popover: '#1C1C1F',
      warning: '#F5A524',
      mutedForeground: '#A1A1AA',
      border: '#2A2A2E',
      input: '#6B6B73',
      primary: '#007BA7',
      primaryPressed: '#00698F',
      primaryForeground: '#FFFFFF',
      link: '#3AB0E0',
      ring: '#3AB0E0',
      accent: '#FF2D95',
      accentForeground: '#0A0A0A',
      destructive: '#EF4444',
      destructiveForeground: '#0A0A0A',
    });
  });

  it('keeps errors distinct from the rose accent', () => {
    expect(colors.destructive).not.toBe(colors.accent);
  });

  it('only uses 6-digit hex values', () => {
    for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
  });
});

/** WCAG relative luminance contrast ratio. */
function contrast(a: string, b: string): number {
  const channel = (hex: string, i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) =>
    0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('contrast (WCAG AA)', () => {
  it.each([
    ['foreground on background', colors.foreground, colors.background, 4.5],
    ['muted text on card', colors.mutedForeground, colors.card, 4.5],
    ['muted text on secondary', colors.mutedForeground, colors.secondary, 4.5],
    ['text on primary', colors.primaryForeground, colors.primary, 4.5],
    ['link on background', colors.link, colors.background, 4.5],
    ['rose on background', colors.accent, colors.background, 4.5],
    ['text on rose', colors.accentForeground, colors.accent, 4.5],
    ['error text on background', colors.destructive, colors.background, 4.5],
    ['error text on card', colors.destructive, colors.card, 4.5],
    ['text on destructive', colors.destructiveForeground, colors.destructive, 4.5],
    ['input border on background', colors.input, colors.background, 3],
    ['focus ring on background', colors.ring, colors.background, 3],
  ])('%s', (_name, fg, bg, min) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});
