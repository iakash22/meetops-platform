import { describe, expect, it } from 'vitest';
import { acknowledge, canStartRecording, initialConsent, showNotice } from '../src/lib/consent.js';

describe('consent', () => {
  it('blocks recording until acknowledged', () => {
    const s0 = initialConsent();
    expect(canStartRecording(s0)).toBe(false);
    const s1 = showNotice(s0);
    expect(canStartRecording(s1)).toBe(false);
    const s2 = acknowledge(s1, 123);
    expect(s2).toEqual({ status: 'acknowledged', acknowledgedAt: 123 });
    expect(canStartRecording(s2)).toBe(true);
  });

  it('cannot acknowledge without the notice being shown', () => {
    expect(() => acknowledge(initialConsent())).toThrow();
  });

  it('showNotice is idempotent once acknowledged', () => {
    const s = acknowledge(showNotice(initialConsent()), 1);
    expect(showNotice(s)).toBe(s);
  });
});
