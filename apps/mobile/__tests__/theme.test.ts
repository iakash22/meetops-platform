import { colors } from '../src/theme/colors';

describe('brand palette (dark-first)', () => {
  it('matches the owner-approved tokens', () => {
    expect(colors).toMatchObject({
      background: '#0A0A0A',
      foreground: '#F5F5F7',
      card: '#141416',
      muted: '#1C1C1F',
      mutedForeground: '#A1A1AA',
      border: '#2A2A2E',
      primary: '#007BA7',
      ring: '#007BA7',
      accent: '#FF2D95',
    });
  });

  it('only uses 6-digit hex values', () => {
    for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9A-F]{6}$/);
  });
});
