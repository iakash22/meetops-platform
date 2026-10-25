import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Overline,
  PageHeader,
  SectionHeader,
  Timecode,
  formatTimecode,
} from '@/components/ui/typography';
import { PageHeader as LegacyPageHeader } from '@/pages/resource-list';

describe('typography patterns', () => {
  it('PageHeader renders one h1 with eyebrow, description and actions', () => {
    render(
      <PageHeader
        eyebrow="Workspace"
        title="Meetings"
        description="All recorded meetings"
        actions={<button type="button">New</button>}
      />,
    );
    const h1 = screen.getByRole('heading', { level: 1, name: 'Meetings' });
    expect(h1).toHaveClass('text-h1');
    expect(screen.getByText('Workspace')).toHaveClass('text-overline', 'uppercase');
    expect(screen.getByText('All recorded meetings')).toHaveClass(
      'text-muted-foreground',
      'measure',
    );
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });

  it('keeps the legacy resource-list PageHeader import working', () => {
    expect(LegacyPageHeader).toBe(PageHeader);
  });

  it('SectionHeader defaults to h2 and supports h3', () => {
    const { rerender } = render(<SectionHeader title="Action items" />);
    expect(screen.getByRole('heading', { level: 2, name: 'Action items' })).toHaveClass('text-h4');
    rerender(<SectionHeader as="h3" title="Owners" description="Who is on point" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Owners' })).toHaveClass('text-h5');
  });

  it('Overline tones map to colour tokens', () => {
    render(<Overline tone="highlight">Live</Overline>);
    expect(screen.getByText('Live')).toHaveClass('text-highlight');
  });

  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65.9, '1:05'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [-4, '0:00'],
    [Number.NaN, '0:00'],
  ])('formatTimecode(%s) → %s', (input, out) => {
    expect(formatTimecode(input)).toBe(out);
  });

  it('Timecode is a semantic <time> with tabular mono styling', () => {
    render(<Timecode seconds={754} />);
    const t = screen.getByText('12:34');
    expect(t.tagName).toBe('TIME');
    expect(t).toHaveAttribute('datetime', 'PT754S');
    expect(t).toHaveClass('timecode');
  });
});

describe('font + motion wiring', () => {
  const root = resolve(__dirname, '..');
  const css = readFileSync(resolve(root, 'src/index.css'), 'utf8');
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');

  it('self-hosts both fonts with swap + latin unicode-range', () => {
    for (const file of ['InterVariable-latin.woff2', 'JetBrainsMono-latin.woff2']) {
      expect(css).toContain(`url('/fonts/${file}')`);
      expect(readFileSync(resolve(root, 'public/fonts', file)).byteLength).toBeLessThan(64_000);
    }
    expect(css.match(/font-display: swap/g)?.length).toBe(2);
    expect(css).toContain('unicode-range');
  });

  it('preloads only the sans font', () => {
    const preloads = html.match(/rel="preload"[^>]*as="font"/g) ?? [];
    expect(preloads).toHaveLength(1);
    expect(html).toContain('href="/fonts/InterVariable-latin.woff2"');
  });

  it('guards smooth scroll and scroll-driven reveal behind reduced-motion checks', () => {
    expect(css).toMatch(
      /prefers-reduced-motion: no-preference\)\s*{\s*html\s*{\s*scroll-behavior: smooth/,
    );
    expect(css).toMatch(
      /@supports \(animation-timeline: view\(\)\)\s*{\s*@media \(prefers-reduced-motion: no-preference\)/,
    );
  });

  it('ships the OFL licence next to the font files', () => {
    for (const f of ['OFL-Inter.txt', 'OFL-JetBrainsMono.txt']) {
      expect(readFileSync(resolve(root, 'public/fonts', f), 'utf8')).toContain(
        'SIL Open Font License',
      );
    }
  });
});

describe('cn() with type-scale tokens', () => {
  it('keeps a type-scale size alongside a colour, and lets sizes override each other', async () => {
    const { cn } = await import('@/lib/utils');
    expect(cn('text-h1', 'text-foreground')).toBe('text-h1 text-foreground');
    expect(cn('text-sm', 'text-caption')).toBe('text-caption');
    expect(cn('text-h2', 'text-h3')).toBe('text-h3');
  });
});
