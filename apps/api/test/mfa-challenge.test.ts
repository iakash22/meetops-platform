import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MFA_CHALLENGE_TTL_MS,
  credentialsFingerprint,
  newMfaChallenge,
  openMfaChallenge,
  sealMfaChallenge,
} from '../src/modules/auth/application/mfa-challenge.js';

const KEY = randomBytes(32);
const NOW = new Date('2026-11-11T12:00:00Z');
const fp = credentialsFingerprint({ passwordHash: 'h', googleSub: null, emailVerifiedAt: NOW });

describe('ADR-021 OQ-17 MFA challenge token', () => {
  it('round-trips user, attempt, first factor and fingerprint until it expires', () => {
    const c = newMfaChallenge('u1', 'password', fp, NOW);
    const sealed = sealMfaChallenge(c, KEY);
    expect(openMfaChallenge(sealed, KEY, NOW.getTime())).toEqual(c);
    expect(openMfaChallenge(sealed, KEY, NOW.getTime() + MFA_CHALLENGE_TTL_MS - 1)).not.toBeNull();
    expect(openMfaChallenge(sealed, KEY, NOW.getTime() + MFA_CHALLENGE_TTL_MS)).toBeNull();
  });

  it('every attempt gets its own id', () => {
    const a = newMfaChallenge('u1', 'password', fp, NOW);
    const b = newMfaChallenge('u1', 'password', fp, NOW);
    expect(a.attemptId).not.toBe(b.attemptId);
    expect(Buffer.from(a.attemptId, 'base64url').length).toBeGreaterThanOrEqual(16);
  });

  it('refuses a tampered body, a foreign key, garbage and an over-long lifetime', () => {
    const c = newMfaChallenge('u1', 'google', fp, NOW);
    const sealed = sealMfaChallenge(c, KEY);
    const [body, mac] = sealed.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), uid: 'u2' }),
    ).toString('base64url');
    expect(openMfaChallenge(`${forged}.${mac}`, KEY, NOW.getTime())).toBeNull();
    expect(openMfaChallenge(sealed, randomBytes(32), NOW.getTime())).toBeNull();
    for (const junk of [undefined, '', '.', 'abc', `${body}.`, 'x'.repeat(2000)])
      expect(openMfaChallenge(junk, KEY, NOW.getTime())).toBeNull();
    const long = sealMfaChallenge({ ...c, expiresAt: new Date(NOW.getTime() + 60 * 60_000) }, KEY);
    expect(openMfaChallenge(long, KEY, NOW.getTime())).toBeNull();
  });

  it('the fingerprint changes with the password, the Google link and the email verification', () => {
    const base = { passwordHash: 'h', googleSub: null, emailVerifiedAt: NOW };
    const all = [
      credentialsFingerprint(base),
      credentialsFingerprint({ ...base, passwordHash: 'h2' }),
      credentialsFingerprint({ ...base, googleSub: 'g' }),
      credentialsFingerprint({ ...base, emailVerifiedAt: null }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});
