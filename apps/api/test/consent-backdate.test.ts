import { describe, expect, it } from 'vitest';
import {
  CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS,
  CURRENT_CONSENT_VERSION,
} from '@meetops/contracts';
import {
  checkConsentInput,
  checkStoredConsent,
  type ConsentRecord,
} from '../src/modules/media/domain/consent.js';

const now = new Date('2026-11-02T12:00:00.000Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const input = (attestedAt: string) => ({
  consentVersion: CURRENT_CONSENT_VERSION,
  attestedAt,
  method: 'all_parties_consented',
});
const reason = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return (e as { consentReason?: string }).consentReason;
  }
};

describe('consent attestedAt back-dating bound (24 h)', () => {
  it('is 24 hours', () => expect(CONSENT_ATTESTATION_MAX_BACKDATE_SECONDS).toBe(86_400));

  it('accepts up to 24 h old, rejects older with CONSENT_INVALID', () => {
    expect(
      reason(() => checkConsentInput(input(ago(23 * 3600)), now, CURRENT_CONSENT_VERSION)),
    ).toBeNull();
    expect(
      reason(() => checkConsentInput(input(ago(86_400)), now, CURRENT_CONSENT_VERSION)),
    ).toBeNull();
    expect(reason(() => checkConsentInput(input(ago(86_401)), now, CURRENT_CONSENT_VERSION))).toBe(
      'CONSENT_INVALID',
    );
    expect(
      reason(() =>
        checkConsentInput(input('2001-01-01T00:00:00.000Z'), now, CURRENT_CONSENT_VERSION),
      ),
    ).toBe('CONSENT_INVALID');
  });

  it('re-checks a stored attestation against its recordedAt', () => {
    const rec = (attestedAt: string): ConsentRecord => ({
      id: 'c',
      organizationId: 'o',
      subjectType: 'upload',
      subjectId: 's',
      consentVersion: CURRENT_CONSENT_VERSION,
      method: 'all_parties_consented',
      attestedByUserId: 'u',
      attestedAt: new Date(attestedAt),
      recordedAt: now,
    });
    expect(reason(() => checkStoredConsent(rec(ago(3600)), CURRENT_CONSENT_VERSION))).toBeNull();
    expect(reason(() => checkStoredConsent(rec(ago(2 * 86_400)), CURRENT_CONSENT_VERSION))).toBe(
      'CONSENT_INVALID',
    );
  });
});
