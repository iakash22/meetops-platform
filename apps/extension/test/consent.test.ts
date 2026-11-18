import { describe, expect, it } from 'vitest';
import {
  CONSENT_CONFIRMATION,
  CONSENT_NOTICE,
  POPUP_CONSENT_METHOD,
  canStartRecording,
  consentGrant,
  initialConsent,
  setConfirmed,
} from '../src/lib/consent.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';

describe('consent', () => {
  it('blocks recording until the user ticks the confirmation', () => {
    const s0 = initialConsent();
    expect(canStartRecording(s0)).toBe(false);
    const s1 = setConfirmed(true, 123);
    expect(s1).toEqual({ status: 'confirmed', confirmedAt: 123 });
    expect(canStartRecording(s1)).toBe(true);
  });

  it('unticking withdraws consent', () => {
    expect(canStartRecording(setConfirmed(false))).toBe(false);
  });

  it('builds the grant for one meeting only after confirmation', () => {
    expect(() => consentGrant(initialConsent(), MID)).toThrow('Confirm recording consent first');
    expect(consentGrant(setConfirmed(true, 1), MID)).toEqual({
      meetingId: MID,
      method: 'all_parties_consented',
    });
    expect(POPUP_CONSENT_METHOD).toBe('all_parties_consented');
  });

  it('tells participants the microphone is recorded', () => {
    expect(CONSENT_NOTICE).toContain("this tab's audio and your microphone");
    expect(CONSENT_NOTICE).toContain("Chrome's tab indicator");
    expect(CONSENT_CONFIRMATION).toContain('including my microphone');
  });
});
