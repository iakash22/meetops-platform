import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_ORIGIN,
  DEFAULT_WEB_ORIGIN,
  resolveOrigins,
  validateOrigin,
} from '../src/lib/auth/origins.js';
import { buildManifest } from '../src/manifest.js';

describe('build-time origins', () => {
  it('defaults to app.meetops.ai / api.meetops.ai', () => {
    expect(DEFAULT_WEB_ORIGIN).toBe('https://app.meetops.ai');
    expect(DEFAULT_API_ORIGIN).toBe('https://api.meetops.ai');
    expect(resolveOrigins({}, false)).toEqual({
      webOrigin: 'https://app.meetops.ai',
      apiOrigin: 'https://api.meetops.ai',
    });
    expect(resolveOrigins({ WXT_WEB_ORIGIN: '', WXT_API_ORIGIN: '  ' }, false).webOrigin).toBe(
      'https://app.meetops.ai',
    );
  });

  it('accepts overrides and derives externally_connectable from the web origin', () => {
    const o = resolveOrigins(
      {
        WXT_WEB_ORIGIN: 'https://app.staging.example',
        WXT_API_ORIGIN: 'https://api.staging.example:8443',
      },
      false,
    );
    expect(o).toEqual({
      webOrigin: 'https://app.staging.example',
      apiOrigin: 'https://api.staging.example:8443',
    });
    expect(buildManifest(o.webOrigin).externally_connectable).toEqual({
      matches: ['https://app.staging.example/*'],
    });
  });

  it('allows localhost (http or https) in dev mode only', () => {
    expect(resolveOrigins({ WXT_WEB_ORIGIN: 'http://localhost:3000' }, true).webOrigin).toBe(
      'http://localhost:3000',
    );
    expect(validateOrigin('X', 'https://127.0.0.1:8443', true)).toBe('https://127.0.0.1:8443');
    expect(() => resolveOrigins({ WXT_WEB_ORIGIN: 'http://localhost:3000' }, false)).toThrow(
      /localhost only in dev/,
    );
    expect(() => resolveOrigins({ WXT_API_ORIGIN: 'https://localhost' }, false)).toThrow(
      /WXT_API_ORIGIN may use localhost only in dev/,
    );
    expect(() => validateOrigin('X', 'https://api.localhost', false)).toThrow(/localhost/);
  });

  it.each([
    ['http (non-local)', 'http://app.meetops.ai', /https/],
    ['http even in dev', 'http://app.example.com', /https/],
    ['path', 'https://app.meetops.ai/pair', /bare origin/],
    ['trailing slash', 'https://app.meetops.ai/', /bare origin/],
    ['query', 'https://app.meetops.ai?x=1', /bare origin/],
    ['fragment', 'https://app.meetops.ai#x', /bare origin/],
    ['credentials', 'https://user:pw@app.meetops.ai', /bare origin/],
    ['uppercase host', 'https://APP.meetops.ai', /bare origin/],
    ['default port spelled out', 'https://app.meetops.ai:443', /bare origin/],
    ['not a URL', 'app.meetops.ai', /not a valid URL/],
    ['other scheme', 'chrome-extension://abc', /https/],
  ])('rejects %s', (_n, value, err) => {
    expect(() => resolveOrigins({ WXT_WEB_ORIGIN: value }, true)).toThrow(err);
    expect(() => resolveOrigins({ WXT_API_ORIGIN: value }, true)).toThrow(err);
  });
});
