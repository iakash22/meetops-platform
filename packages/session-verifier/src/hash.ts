import { createHash } from 'node:crypto';

/**
 * ADR-011 section 2.4: the one token hash. SHA-256 of the opaque session or extension token, lowercase hex.
 * apps/api's CryptoTokenService.hash MUST return the same value (guarded by a shared-vector test).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Lowercase 64-char hex, the only shape hashToken produces. */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Shared vectors (ADR-011 2.4): the package test and apps/api's CryptoTokenService test both assert these, so the
 * two hashes cannot drift apart.
 */
export const TOKEN_HASH_TEST_VECTORS: readonly (readonly [token: string, sha256Hex: string])[] = [
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['dGVzdC1zZXNzaW9uLXRva2Vu', '828f607c75d5c421d1eac7bb4924c1ccf12bfd06b48a221c701a098776bc4ff6'],
];
