import { describe, expect, it } from "vitest";
import { CONSENT_TTL_MS, consumeConsent, recordConsent } from "../src/lib/consent-registry.js";
import { memoryKV } from "../src/lib/storage.js";

describe("consent registry", () => {
  it("accepts consent for the same tab within the TTL, once", async () => {
    const kv = memoryKV();
    await recordConsent(kv, 5, 1000);
    expect((await consumeConsent(kv, 5, 1000 + CONSENT_TTL_MS)).ok).toBe(true);
    expect((await consumeConsent(kv, 5, 1001)).ok).toBe(false);
  });

  it("rejects missing, other-tab and expired consent", async () => {
    const kv = memoryKV();
    expect((await consumeConsent(kv, 1, 0)).ok).toBe(false);
    await recordConsent(kv, 1, 0);
    expect((await consumeConsent(kv, 2, 0)).ok).toBe(false);
    const r = await consumeConsent(kv, 1, CONSENT_TTL_MS + 1);
    expect(r).toEqual({ ok: false, reason: "Consent expired; acknowledge again" });
  });
});
