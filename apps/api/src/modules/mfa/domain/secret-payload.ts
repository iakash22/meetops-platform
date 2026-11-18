/**
 * The plaintext inside a TOTP factor's TokenCipher envelope (`mfa_factors.secret_enc`, AAD = user + factor):
 * `{ v: 1, s: <base32 TOTP secret>, r: <recovery-code HMAC key> }`. Never logged, never returned after enrolment.
 */
export interface MfaSecretPayload {
  v: 1;
  /** Base32 TOTP secret. */
  s: string;
  /** base64url recovery-code HMAC key. */
  r: string;
}

export function encodeSecretPayload(p: Omit<MfaSecretPayload, 'v'>): string {
  return JSON.stringify({ v: 1, s: p.s, r: p.r });
}

export function decodeSecretPayload(json: string): MfaSecretPayload {
  const p = JSON.parse(json) as Partial<MfaSecretPayload>;
  if (p.v !== 1 || typeof p.s !== 'string' || typeof p.r !== 'string' || !p.s || !p.r)
    throw new Error('invalid MFA secret payload');
  return { v: 1, s: p.s, r: p.r };
}
