/**
 * ADR-021 recovery codes: MFA_RECOVERY_CODE_COUNT single-use codes of 10 base32 characters (50 bits each), shown once
 * as `xxxxx-xxxxx`. Only HMAC-SHA-256(r, normalized code) is stored, where `r` is a per-factor random key kept inside
 * the factor's encrypted payload (so a database dump alone cannot brute-force the 50-bit codes offline). Lookups hash
 * the candidate and match by equality on the hash (no plaintext comparison); a single-use UPDATE ... WHERE used_at IS
 * NULL consumes it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './totp.js';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_KEY_BYTES = 32;

/** Case, spaces and dashes are ignored. Returns null for anything that cannot be a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const n = input.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z2-7]{10}$/.test(n) ? n : null;
}

const format = (n: string) => `${n.slice(0, 5)}-${n.slice(5)}`.toLowerCase();

/** A fresh random HMAC key for a factor's recovery codes (base64url, kept only in the encrypted payload). */
export const generateRecoveryKey = (): string =>
  randomBytes(RECOVERY_KEY_BYTES).toString('base64url');

/** HMAC-SHA-256 of the normalized code, hex. */
export function hashRecoveryCode(recoveryKey: string, normalized: string): string {
  return createHmac('sha256', Buffer.from(recoveryKey, 'base64url'))
    .update(`meetops.mfa.recovery.v1:${normalized}`)
    .digest('hex');
}

/** Constant-time equality of two hex hashes of equal length. */
export function recoveryHashEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export interface GeneratedRecoveryCodes {
  /** Display form, returned to the user once. */
  codes: string[];
  /** HMACs to store (same order). */
  hashes: string[];
}

/** RECOVERY_CODE_COUNT distinct codes and their hashes. */
export function generateRecoveryCodes(
  recoveryKey: string,
  count = RECOVERY_CODE_COUNT,
): GeneratedRecoveryCodes {
  const seen = new Set<string>();
  while (seen.size < count) {
    // 7 random bytes -> 56 bits -> 12 base32 chars; keep 10 (50 bits).
    seen.add(base32Encode(randomBytes(7)).slice(0, RECOVERY_CODE_LENGTH));
  }
  const normalized = [...seen];
  return {
    codes: normalized.map(format),
    hashes: normalized.map((n) => hashRecoveryCode(recoveryKey, n)),
  };
}
