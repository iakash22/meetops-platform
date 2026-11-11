/**
 * ADR-021 OQ-17: after a correct first factor (password or Google), a user with MFA does NOT get a session. They get a
 * short-lived, single-purpose challenge, bound to the user and to this login attempt, carried in an HttpOnly cookie
 * sealed with its own HKDF key. It is not a session: requireSession never accepts it (org APIs answer MFA_REQUIRED),
 * and only POST /auth/mfa/challenge reads it.
 *
 * - `aid`: random login-attempt id; the challenge is single-use (consumed atomically on success, see MfaService).
 * - `cv`: fingerprint of the account credentials when the first factor passed; a password reset, takeover or Google
 *   link change in between voids the challenge (same idea as the X4 re-check).
 * - `lvl`: which first factor passed, for audit only (it never becomes the session level; success issues `mfa`).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Long enough to open the authenticator app, short enough to be useless when stolen. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;

export interface MfaChallenge {
  userId: string;
  attemptId: string;
  firstFactor: 'password' | 'google';
  credentialsFingerprint: string;
  expiresAt: Date;
}

interface Sealed {
  v: 1;
  uid: string;
  aid: string;
  lvl: 'password' | 'google';
  cv: string;
  exp: number;
}

export function credentialsFingerprint(c: {
  passwordHash: string;
  googleSub?: string | null;
  emailVerifiedAt: Date | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'meetops.mfa.challenge.cv.v1',
        c.passwordHash,
        c.googleSub ?? null,
        c.emailVerifiedAt?.getTime() ?? null,
      ]),
    )
    .digest('base64url')
    .slice(0, 22);
}

export function newMfaChallenge(
  userId: string,
  firstFactor: 'password' | 'google',
  fingerprint: string,
  now: Date,
): MfaChallenge {
  return {
    userId,
    attemptId: randomBytes(16).toString('base64url'),
    firstFactor,
    credentialsFingerprint: fingerprint,
    expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
  };
}

export function sealMfaChallenge(c: MfaChallenge, key: Buffer): string {
  const p: Sealed = {
    v: 1,
    uid: c.userId,
    aid: c.attemptId,
    lvl: c.firstFactor,
    cv: c.credentialsFingerprint,
    exp: c.expiresAt.getTime(),
  };
  const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function openMfaChallenge(
  cookie: string | undefined,
  key: Buffer,
  nowMs: number,
): MfaChallenge | null {
  if (!cookie || cookie.length > 1024) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = cookie.slice(0, dot);
  const mac = Buffer.from(cookie.slice(dot + 1));
  const want = Buffer.from(createHmac('sha256', key).update(body).digest('base64url'));
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  let p: Partial<Sealed>;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Sealed>;
  } catch {
    return null;
  }
  if (
    p.v !== 1 ||
    typeof p.uid !== 'string' ||
    typeof p.aid !== 'string' ||
    typeof p.cv !== 'string' ||
    typeof p.exp !== 'number' ||
    (p.lvl !== 'password' && p.lvl !== 'google')
  )
    return null;
  // Expired, or claiming a lifetime longer than we ever issue (forged clock): refuse.
  if (p.exp <= nowMs || p.exp - nowMs > MFA_CHALLENGE_TTL_MS + 30_000) return null;
  return {
    userId: p.uid,
    attemptId: p.aid,
    firstFactor: p.lvl,
    credentialsFingerprint: p.cv,
    expiresAt: new Date(p.exp),
  };
}
