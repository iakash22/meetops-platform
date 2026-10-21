import type { KV } from './storage.js';

/** How long an acknowledgement stays valid before recording must start. */
export const CONSENT_TTL_MS = 2 * 60 * 1000;

export interface ConsentRecord {
  tabId: number;
  acknowledgedAt: number;
  expiresAt: number;
}

const key = (tabId: number) => `consent:${tabId}`;

/** Background-side record of the user's acknowledgement, bound to one tab. */
export async function recordConsent(kv: KV, tabId: number, now: number): Promise<ConsentRecord> {
  const rec = { tabId, acknowledgedAt: now, expiresAt: now + CONSENT_TTL_MS };
  await kv.set(key(tabId), rec);
  return rec;
}

/**
 * Verify and consume consent for a tab. One-shot: a successful check removes
 * the record so each recording requires a fresh acknowledgement.
 */
export function consumeConsent(
  kv: KV,
  tabId: number,
  now: number,
): Promise<{ ok: true; record: ConsentRecord } | { ok: false; reason: string }> {
  // Serialise per storage object so two concurrent consumers can't both read the record
  // before either removes it (get-then-remove is not atomic in chrome.storage).
  const prev = locks.get(kv) ?? Promise.resolve();
  const run = prev.then(() => consumeUnlocked(kv, tabId, now));
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
): Promise<{ ok: true; record: ConsentRecord } | { ok: false; reason: string }> {
  const rec = await kv.get<ConsentRecord>(key(tabId));
  if (!rec) return { ok: false, reason: 'Consent not acknowledged for this tab' };
  await kv.remove(key(tabId));
  if (rec.tabId !== tabId) return { ok: false, reason: 'Consent bound to a different tab' };
  if (now > rec.expiresAt) return { ok: false, reason: 'Consent expired; acknowledge again' };
  return { ok: true, record: rec };
}
