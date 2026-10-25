import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// FE-1 screens use only brand-theme semantic tokens (bg-background, text-muted-foreground,
// border-border, bg-primary...) and shared components/ui primitives: no raw colours.
const ROOT = join(__dirname, '..', 'src', 'features');
const DIRS = ['directory', 'employees', 'teams', 'projects', 'settings'];
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|' +
  'indigo|violet|purple|fuchsia|pink|rose|black|white';
const RAW_COLOUR = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|\\b(?:rgb|rgba|hsl|hsla|oklch)\\(|` +
    `\\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|divide|placeholder|shadow|decoration|accent|caret)` +
    `-(?:${PALETTE})(?:-\\d{2,3})?\\b`,
);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('FE-1 brand theme', () => {
  const sources = DIRS.flatMap((d) => files(join(ROOT, d)));

  it('finds the FE-1 sources', () => {
    expect(sources.length).toBeGreaterThan(8);
  });

  it.each(sources.map((f) => [relative(ROOT, f), f]))(
    '%s has no hard-coded colours',
    (_n, file) => {
      const offending = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => RAW_COLOUR.test(line));
      expect(offending).toEqual([]);
    },
  );

  it('does not render native selects (use components/ui/select)', () => {
    for (const file of sources) expect(readFileSync(file, 'utf8')).not.toMatch(/<select\b/);
  });
});
