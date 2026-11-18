/**
 * ADR-021 TOTP core (RFC 4226 HOTP / RFC 6238 TOTP) on node:crypto only, no new dependency.
 *
 * Parameters (authenticator-app compatible): HMAC-SHA-1, 6 digits, 30 s period, 160-bit secret, accept the current
 * step +/- TOTP_WINDOW_STEPS (OQ-2 default 1). Verification compares the code against EVERY step in the window with
 * timingSafeEqual and no early return, and only accepts a step strictly greater than the factor's `lastUsedStep`
 * (replay guard). The caller persists the returned step with a compare-and-set so two concurrent requests with the
 * same code cannot both win.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_SECRET_BYTES = 20;
/** ADR-021 OQ-2 default: one step of clock skew either way. */
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_ISSUER = 'MeetOps';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding (authenticator apps accept it unpadded). */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Strict RFC 4648 base32 decode (case-insensitive, optional `=` padding). Throws on any other character. */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit TOTP secret, base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** RFC 4226 HOTP value for `counter` (dynamic truncation), zero-padded to `digits`. */
export function hotp(key: Buffer, counter: number | bigint, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 time step for a unix time in ms. */
export const totpStep = (atMs: number, periodS = TOTP_PERIOD_SECONDS): number =>
  Math.floor(atMs / 1000 / periodS);

/** RFC 6238 TOTP for a base32 secret at `atMs`. */
export function totpAt(secretB32: string, atMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretB32), totpStep(atMs), digits);
}

export interface TotpVerifyInput {
  secretB32: string;
  code: string;
  nowMs: number;
  /** Highest step already accepted for this factor (replay guard); null when never used. */
  lastUsedStep: number | null;
  window?: number;
}

/**
 * Constant-time TOTP check. Returns the matched step (the caller stores it as the new `lastUsedStep` with a CAS), or
 * null. Every window slot is computed and compared (no early return); a step at or below `lastUsedStep` never matches.
 * A malformed code is compared against a dummy so the work done does not depend on the input shape.
 */
export function verifyTotp(input: TotpVerifyInput): number | null {
  const window = input.window ?? TOTP_WINDOW_STEPS;
  const wellFormed = /^[0-9]{6}$/.test(input.code);
  const given = Buffer.from(wellFormed ? input.code : '000000', 'ascii');
  const key = base32Decode(input.secretB32);
  const current = totpStep(input.nowMs);
  let matched: number | null = null;
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    const expected = Buffer.from(hotp(key, Math.max(step, 0)), 'ascii');
    const equal = timingSafeEqual(expected, given);
    const fresh = input.lastUsedStep === null || step > input.lastUsedStep;
    // Prefer the highest matching step so a replay guard advance is maximal; no branch on secret data beyond this.
    if (equal && fresh && step >= 0 && wellFormed) matched = step;
  }
  key.fill(0);
  return matched;
}

/** otpauth:// URI for QR enrolment (Key URI Format). Shown once; never logged (otpauthUri is a REDACT key). */
export function otpauthUri(secretB32: string, accountName: string, issuer = TOTP_ISSUER): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const q = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
