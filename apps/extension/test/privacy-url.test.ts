import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSafePrivacyUrl,
  missingPrivacyUrlWarning,
  resolvePrivacyUrl,
} from '../src/lib/privacy-url';

describe('privacy URL helpers', () => {
  it('accepts https and same-origin paths, rejects other schemes', () => {
    expect(isSafePrivacyUrl('https://example.com/privacy')).toBe(true);
    expect(isSafePrivacyUrl('/legal/privacy')).toBe(true);
    expect(isSafePrivacyUrl('http://example.com/privacy')).toBe(false);
    expect(isSafePrivacyUrl('javascript:alert(1)')).toBe(false);
    expect(isSafePrivacyUrl(undefined)).toBe(false);
    expect(isSafePrivacyUrl('')).toBe(false);
  });

  it('resolves paths against the web origin and leaves https URLs alone', () => {
    expect(resolvePrivacyUrl('https://x.test/privacy', 'https://app.meetops.ai')).toBe(
      'https://x.test/privacy',
    );
    expect(resolvePrivacyUrl('/legal/privacy', 'https://app.meetops.ai/')).toBe(
      'https://app.meetops.ai/legal/privacy',
    );
    expect(resolvePrivacyUrl('/legal/privacy', undefined)).toBeUndefined();
    expect(resolvePrivacyUrl('javascript:alert(1)', 'https://app.meetops.ai')).toBeUndefined();
  });

  it('warns only when the production privacy URL is missing or unsafe', () => {
    expect(missingPrivacyUrlWarning('https://x.test/privacy')).toBeUndefined();
    expect(missingPrivacyUrlWarning('/privacy')).toBeUndefined();
    expect(missingPrivacyUrlWarning(undefined)).toMatch(/WXT_PRIVACY_URL is not set/);
    expect(missingPrivacyUrlWarning('http://insecure.test/privacy')).toMatch(
      /WXT_PRIVACY_URL is not set/,
    );
  });
});

describe('privacy URL warning is not a build failure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a warning, not an exception, when the helper result is printed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const message = missingPrivacyUrlWarning(undefined);
    if (message) console.warn(message);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/will be omitted/);
  });
});
