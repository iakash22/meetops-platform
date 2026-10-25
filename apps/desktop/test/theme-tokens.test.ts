import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards parity with apps/web/src/index.css and docs/05-web/brand-theme.md (owner palette).
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

const EXPECTED: Record<string, string> = {
  background: '0 0% 3.9%', // #0A0A0A
  foreground: '240 11.1% 96.5%', // #F5F5F7
  card: '240 4.8% 8.2%', // #141416
  popover: '240 5.1% 11.6%', // #1C1C1F
  primary: '195.8 100% 32.7%', // #007BA7
  'primary-foreground': '0 0% 100%', // #FFFFFF
  link: '197.3 72.8% 55.3%', // #3AB0E0
  ring: '197.3 72.8% 55.3%', // #3AB0E0
  highlight: '330.3 100% 58.8%', // #FF2D95
  'highlight-foreground': '0 0% 3.9%', // #0A0A0A
  accent: '240 5.1% 11.6%', // neutral hover surface, as in shadcn/web
  'muted-foreground': '240 5% 64.9%', // #A1A1AA
  destructive: '0 84.2% 60.2%', // #EF4444
  border: '240 4.5% 17.3%', // #2A2A2E
  input: '240 3.6% 43.5%', // #6B6B73
  radius: '0.75rem',
  'duration-fast': '150ms',
  'duration-base': '200ms',
};

describe('brand theme tokens', () => {
  it.each(Object.entries(EXPECTED))('--%s matches the web token', (name, value) => {
    expect(css).toMatch(new RegExp(`--${name}: ${value.replace(/\./g, '\\.')};`));
  });

  it('disables motion under prefers-reduced-motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
