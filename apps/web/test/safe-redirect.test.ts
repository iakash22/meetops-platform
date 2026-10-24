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

  it.each([
    '/%2F%2Fevil.com',
    '/%2f%2fevil.com',
    '/%5Cevil.com',
    '/%5cevil',
    '/%252F%252Fevil.com',
    '/%0aevil',
  ])('rejects encoded unsafe path %s after decoding', (input) => {
    expect(safeRedirect(input, '/home')).toBe('/home');
  });

  it('keeps harmless encoded characters', () => {
    expect(safeRedirect('/meetings?q=a%20b')).toBe('/meetings?q=a%20b');
  });

  it.each([
    '/.//evil.com',
    '/..//evil.com',
    '/./..//evil.com',
    '/a/../..//evil.com',
    '/a/..//evil.com',
    '/%2E//evil.com',
    '/%2e%2e//evil.com',
    '/%2e/%2e%2e//evil.com',
    '/.//evil.com/path?x=1#h',
    '/./\\evil.com',
    '/.%2F/evil.com',
    '/..%5C%5Cevil.com',
  ])('rejects dot-segment escape %j (normalises to //host)', (input) => {
    expect(safeRedirect(input, '/home')).toBe('/home');
  });

  it('still normalises harmless dot segments to a same-origin path', () => {
    expect(safeRedirect('/a/./b/../c?x=1#y')).toBe('/a/c?x=1#y');
    expect(safeRedirect('/../meetings')).toBe('/meetings');
  });
});
