import { describe, expect, it } from 'vitest';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import {
  CONSENT_TTL_MS,
  consumeConsent,
  recordConsent,
  toAttestation,
} from '../src/lib/consent-registry.js';
import { memoryKV } from '../src/lib/storage.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const GRANT = { meetingId: MID, method: 'all_parties_consented' as const };

describe('consent registry', () => {
  it('accepts consent for the same tab within the TTL, once', async () => {
    const kv = memoryKV();
    await recordConsent(kv, 5, 1000, GRANT);
    expect((await consumeConsent(kv, 5, 1000 + CONSENT_TTL_MS, MID)).ok).toBe(true);
    expect((await consumeConsent(kv, 5, 1001, MID)).ok).toBe(false);
  });

  it('rejects missing, other-tab and expired consent', async () => {
    const kv = memoryKV();
    expect((await consumeConsent(kv, 1, 0, MID)).ok).toBe(false);
    await recordConsent(kv, 1, 0, GRANT);
    expect((await consumeConsent(kv, 2, 0, MID)).ok).toBe(false);
    const r = await consumeConsent(kv, 1, CONSENT_TTL_MS + 1, MID);
    expect(r).toEqual({ ok: false, reason: 'Consent expired; acknowledge again' });
  });

  it('binds consent to one meeting and consumes it even on a mismatch', async () => {
    const kv = memoryKV();
    await recordConsent(kv, 1, 0, GRANT);
    const other = await consumeConsent(kv, 1, 0, '0b4e7f1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(other).toEqual({ ok: false, reason: 'Consent was given for a different meeting' });
    expect((await consumeConsent(kv, 1, 0, MID)).ok).toBe(false);
  });

  it('builds the contracts v0.4.1 attestation from what the user confirmed', async () => {
    const kv = memoryKV();
    const rec = await recordConsent(kv, 1, Date.parse('2026-10-25T08:00:00.000Z'), {
      meetingId: MID,
      method: 'all_parties_notified',
    });
    expect(toAttestation(rec)).toEqual({
      consentVersion: CURRENT_CONSENT_VERSION,
      attestedAt: '2026-10-25T08:00:00.000Z',
      method: 'all_parties_notified',
    });
  });
});
