/**
 * ADR-021 OQ-17 (Amendment 1): the login MFA challenge.
 *
 * After a correct first factor (password or Google), a user with MFA on gets a short-lived, single-purpose challenge
 * token instead of a session. It is not a session: no session row and no cookie exist yet, it carries no org data and
 * it is accepted only by POST /auth/mfa/challenge. That route (enrolment / challenge PR) looks the token up with
 * `resolve`, checks the TOTP or recovery code for `challenge.userId`, then calls `complete` (atomic single use) and
 * only then creates the session at level `mfa`. A wrong code calls `fail`, which burns the challenge at the cap
 * (the account-wide ADR-006 lockout of OQ-4 applies on top).
 *
 * Storage keeps only SHA-256(token) (TokenService.hash), the user, the first factor and the expiry
 * (MFA_CHALLENGE_TTL_SECONDS, also pinned by a DB CHECK).
 */
import { MFA_CHALLENGE_PURPOSE, MFA_CHALLENGE_TTL_SECONDS } from '@meetops/contracts';
import type { TokenService } from '../../auth/domain/ports.js';
import type { IdGenerator } from '../../../shared/ports.js';

export const MFA_CHALLENGE_TTL_MS = MFA_CHALLENGE_TTL_SECONDS * 1000;
/** Wrong codes accepted against one challenge before it is burned (a fresh login is then needed). */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

export type MfaChallengePurpose = typeof MFA_CHALLENGE_PURPOSE;
/** How the user proved the first factor. Google's amr/acr never elevate (OQ-3); Google is a first factor only. */
export type MfaFirstFactor = 'password' | 'google';

export interface MfaChallenge {
  id: string;
  userId: string;
  purpose: MfaChallengePurpose;
  firstFactor: MfaFirstFactor;
  /** SHA-256 hex of the token. The raw token is only ever in the login response. */
  tokenHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface MfaChallengeRepository {
  create(c: MfaChallenge): Promise<void>;
  /** The live challenge for this hash (purpose `mfa_challenge`, unused, unexpired), or null. Does not consume it. */
  findLive(tokenHash: string, now: Date): Promise<MfaChallenge | null>;
  /**
   * Atomic single use, bound to the user: `UPDATE ... SET used_at = now WHERE id = $1 AND user_id = $2 AND purpose =
   * 'mfa_challenge' AND used_at IS NULL AND expires_at > now RETURNING *`. Null when it lost a race, was used or expired.
   */
  consume(id: string, userId: string, now: Date): Promise<MfaChallenge | null>;
  /** Counts one wrong code; at `maxAttempts` the challenge is burned (used_at set). Returns the attempts so far. */
  recordFailure(id: string, now: Date, maxAttempts: number): Promise<number>;
  /** Burns every live challenge of the user (takeover claim OQ-15, factor removal, password reset). */
  invalidateForUser(userId: string, now: Date): Promise<void>;
}

export interface IssuedMfaChallenge {
  /** Returned to the client once, as MfaLoginChallenge.challengeToken. Never stored or logged. */
  challengeToken: string;
  expiresAt: Date;
  challenge: MfaChallenge;
}

const PURPOSE: MfaChallengePurpose = MFA_CHALLENGE_PURPOSE;

export class MfaChallengeService {
  constructor(
    private readonly deps: {
      challenges: MfaChallengeRepository;
      tokens: TokenService;
      ids: IdGenerator;
    },
  ) {}

  /** Login step 1 for an MFA user: mint a challenge. The caller must NOT create a session or set a cookie. */
  async issue(userId: string, firstFactor: MfaFirstFactor, now: Date): Promise<IssuedMfaChallenge> {
    const challengeToken = this.deps.tokens.generate();
    const challenge: MfaChallenge = {
      id: this.deps.ids.next(),
      userId,
      purpose: PURPOSE,
      firstFactor,
      tokenHash: this.deps.tokens.hash(challengeToken),
      attempts: 0,
      expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
      usedAt: null,
      createdAt: now,
    };
    await this.deps.challenges.create(challenge);
    return { challengeToken, expiresAt: challenge.expiresAt, challenge };
  }

  /** The live challenge behind a presented token, or null (unknown, used, expired, wrong purpose or malformed). */
  async resolve(challengeToken: string, now: Date): Promise<MfaChallenge | null> {
    if (typeof challengeToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(challengeToken))
      return null;
    const c = await this.deps.challenges.findLive(this.deps.tokens.hash(challengeToken), now);
    return c && c.purpose === PURPOSE && !c.usedAt && c.expiresAt > now ? c : null;
  }

  /**
   * The code was correct: use the challenge up (once, for its own user). Only when this returns non-null may the
   * caller create the `mfa` session.
   */
  async complete(c: MfaChallenge, now: Date): Promise<MfaChallenge | null> {
    return this.deps.challenges.consume(c.id, c.userId, now);
  }

  /** The code was wrong: count it, burning the challenge at MFA_CHALLENGE_MAX_ATTEMPTS. True when it is now burned. */
  async fail(c: MfaChallenge, now: Date): Promise<boolean> {
    const n = await this.deps.challenges.recordFailure(c.id, now, MFA_CHALLENGE_MAX_ATTEMPTS);
    return n >= MFA_CHALLENGE_MAX_ATTEMPTS;
  }

  invalidateForUser(userId: string, now: Date): Promise<void> {
    return this.deps.challenges.invalidateForUser(userId, now);
  }
}
