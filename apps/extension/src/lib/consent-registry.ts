import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import type { ConsentAttestationInput, ConsentMethod } from '@meetops/contracts/types';
import type { KV } from './storage.js';

/** How long an acknowledgement stays valid before recording must start. */
export const CONSENT_TTL_MS = 2 * 60 * 1000;

export interface ConsentRecord {
  tabId: number;
  /** The meeting the user consented to record. Consent never carries over to another meeting. */
  meetingId: string;
  /** What the user confirmed in the popup (contracts CONSENT_METHODS). */
  method: ConsentMethod;
  acknowledgedAt: number;
  expiresAt: number;
}

/** What the user confirmed for one meeting, sent with ACK_CONSENT. */
export interface ConsentGrant {
  meetingId: string;
  method: ConsentMethod;
}

const key = (tabId: number) => `consent:${tabId}`;

/** Background-side record of the user's acknowledgement, bound to one tab and one meeting. */
export async function recordConsent(
  kv: KV,
  tabId: number,
  now: number,
  grant: ConsentGrant,
): Promise<ConsentRecord> {
  const rec: ConsentRecord = {
    tabId,
    meetingId: grant.meetingId,
    method: grant.method,
    acknowledgedAt: now,
    expiresAt: now + CONSENT_TTL_MS,
  };
  await kv.set(key(tabId), rec);
  return rec;
}

/**
 * Verify and consume consent for a tab and meeting. One-shot: any check removes
 * the record so each recording requires a fresh acknowledgement.
 */
export function consumeConsent(
  kv: KV,
  tabId: number,
  now: number,
  meetingId: string,
): Promise<{ ok: true; record: ConsentRecord } | { ok: false; reason: string }> {
  // Serialise per storage object so two concurrent consumers can't both read the record
  // before either removes it (get-then-remove is not atomic in chrome.storage).
  const prev = locks.get(kv) ?? Promise.resolve();
  const run = prev.then(() => consumeUnlocked(kv, tabId, now, meetingId));
  locks.set(
    kv,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

const locks = new WeakMap<KV, Promise<void>>();

async function consumeUnlocked(
  kv: KV,
  tabId: number,
  now: number,
  meetingId: string,
): Promise<{ ok: true; record: ConsentRecord } | { ok: false; reason: string }> {
  const rec = await kv.get<ConsentRecord>(key(tabId));
  if (!rec) return { ok: false, reason: 'Consent not acknowledged for this tab' };
  await kv.remove(key(tabId));
  if (rec.tabId !== tabId) return { ok: false, reason: 'Consent bound to a different tab' };
  if (rec.meetingId !== meetingId)
    return { ok: false, reason: 'Consent was given for a different meeting' };
  if (now > rec.expiresAt) return { ok: false, reason: 'Consent expired; acknowledge again' };
  return { ok: true, record: rec };
}

/**
 * The contracts v0.4.1 attestation for a consumed record: the notice version the popup showed, the moment the user
 * confirmed, and what they confirmed. The server fills in who attested and for which organization.
 */
export function toAttestation(rec: ConsentRecord): ConsentAttestationInput {
  return {
    consentVersion: CURRENT_CONSENT_VERSION,
    attestedAt: new Date(rec.acknowledgedAt).toISOString(),
    method: rec.method,
  };
}
