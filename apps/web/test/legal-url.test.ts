import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSafeLegalUrl, missingPrivacyUrlWarning } from '@/lib/legal-url';

describe('isSafeLegalUrl', () => {
  it('accepts https and same-origin paths', () => {
    expect(isSafeLegalUrl('https://x.test/privacy')).toBe(true);
    expect(isSafeLegalUrl('/legal/privacy')).toBe(true);
  });

  it('rejects missing, empty, and unsafe schemes', () => {
    expect(isSafeLegalUrl(undefined)).toBe(false);
    expect(isSafeLegalUrl('')).toBe(false);
    expect(isSafeLegalUrl('http://x.test/privacy')).toBe(false);
    expect(isSafeLegalUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('missingPrivacyUrlWarning', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is silent when a safe privacy URL is set', () => {
    expect(missingPrivacyUrlWarning('https://x.test/privacy')).toBeUndefined();
    expect(missingPrivacyUrlWarning('/privacy')).toBeUndefined();
  });

  it('returns a warning, not a failure, when the URL is missing in production', () => {
    const message = missingPrivacyUrlWarning(undefined);
    expect(message).toMatch(/VITE_PRIVACY_URL is not set/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    if (message) console.warn(message);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
