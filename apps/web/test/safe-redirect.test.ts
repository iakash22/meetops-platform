import { describe, expect, it } from 'vitest';
import { safeRedirect } from '@/lib/safe-redirect';

describe('safeRedirect', () => {
  it.each([
    ['/meetings', '/meetings'],
    ['/meetings/1?tab=summary#top', '/meetings/1?tab=summary#top'],
    ['/', '/'],
  ])('accepts same-origin relative path %s', (input, expected) => {
    expect(safeRedirect(input)).toBe(expected);
  });

  it.each([
    '//evil.com',
    '//evil.com/path',
    '/\\evil.com',
    '\\evil.com',
    '/foo\\bar',
    'https://evil.com',
    'http://localhost/x',
    'javascript:alert(1)',
    'meetings',
    '',
    '/\tevil',
  ])('rejects %j', (input) => {
    expect(safeRedirect(input, '/home')).toBe('/home');
  });

  it('rejects non-strings and control characters', () => {
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect(42)).toBe('/');
    expect(safeRedirect('/a\nb')).toBe('/');
  });
});
