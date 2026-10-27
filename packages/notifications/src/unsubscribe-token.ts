import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed, expiring, single-purpose tokens for product-mail links (one-click unsubscribe and the preferences page).
 * Format: `<base64url(json claims)>.<base64url(HMAC-SHA256)>`. The secret comes from config (never from code); a token
 * minted for one purpose is rejected for another. Claims hold ids only, never addresses.
 */
export type EmailLinkPurpose = 'unsubscribe' | 'preferences';

export interface EmailLinkClaims {
  purpose: EmailLinkPurpose;
  userId: string;
  organizationId: string;
  /** Product template id / category the link applies to. */
  category: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

const MIN_SECRET_BYTES = 32;

function b64(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(`meetops-email-link.v1.${body}`).digest();
}

function checkSecret(secret: string) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error(`Email link secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
}

export function signEmailLinkToken(
  secret: string,
  claims: Omit<EmailLinkClaims, 'exp'>,
  options: { ttlSeconds: number; now?: Date },
): string {
  checkSecret(secret);
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) throw new Error('ttlSeconds must be a positive integer');
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const body = b64(JSON.stringify({ ...claims, exp: now + options.ttlSeconds }));
  return `${body}.${b64(sign(secret, body))}`;
}

/** Returns the claims, or null when malformed, tampered, expired or minted for another purpose. */
export function verifyEmailLinkToken(
  secret: string,
  token: string,
  purpose: EmailLinkPurpose,
  now: Date = new Date(),
): EmailLinkClaims | null {
  checkSecret(secret);
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts as [string, string];
  const expected = sign(secret, body);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: EmailLinkClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as EmailLinkClaims;
  } catch {
    return null;
  }
  if (!claims || claims.purpose !== purpose) return null;
  if (typeof claims.userId !== 'string' || typeof claims.organizationId !== 'string' || typeof claims.category !== 'string') return null;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(now.getTime() / 1000)) return null;
  return claims;
}
