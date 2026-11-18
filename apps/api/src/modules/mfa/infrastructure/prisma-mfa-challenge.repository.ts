import { MFA_CHALLENGE_TTL_SECONDS } from '@meetops/contracts';
import { getPrismaClient, type DatabaseClient } from '../../../shared/prisma/context.js';
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  type MfaChallenge,
  type MfaChallengeRepository,
  type MfaFirstFactor,
} from '../domain/challenge.js';

type Row = {
  id: string;
  user_id: string;
  purpose: string;
  first_factor: string;
  token_hash: string;
  attempts: number;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

const out = (r: Row): MfaChallenge => ({
  id: r.id,
  userId: r.user_id,
  purpose: 'mfa_challenge',
  firstFactor: r.first_factor as MfaFirstFactor,
  tokenHash: r.token_hash,
  attempts: r.attempts,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  createdAt: r.created_at,
});

/**
 * mfa_challenges (ADR-021 OQ-17; global table like password_resets, no RLS). The attempt cap, single use and user
 * binding are each one conditional UPDATE, so concurrent requests and API instances cannot both win. Expiry
 * comparisons and created_at / expires_at / used_at stamps use the database clock (`now()`).
 */
export class PrismaMfaChallengeRepository implements MfaChallengeRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}

  async create(c: MfaChallenge) {
    const rows = await this.db.$queryRaw<Row[]>`
      INSERT INTO mfa_challenges (
        id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at
      )
      VALUES (
        ${c.id}::uuid, ${c.userId}::uuid, ${c.purpose}, ${c.firstFactor}, ${c.tokenHash}, ${c.attempts},
        now() + (${MFA_CHALLENGE_TTL_SECONDS}::int * interval '1 second'), NULL, now()
      )
      RETURNING id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at`;
    const row = rows[0];
    if (!row) throw new Error('mfa_challenges_insert_failed');
    return out(row);
  }

  async findLive(tokenHash: string, now: Date) {
    void now; // expiry is compared to the database clock, not the app clock
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at
      FROM mfa_challenges
      WHERE token_hash = ${tokenHash} AND purpose = 'mfa_challenge'
        AND used_at IS NULL AND expires_at > now()`;
    return rows[0] ? out(rows[0]) : null;
  }

  async reserveAttempt(tokenHash: string, userId: string, maxAttempts: number, now: Date) {
    void now; // expiry is compared to the database clock, not the app clock
    const rows = await this.db.$queryRaw<Row[]>`
      UPDATE mfa_challenges SET attempts = attempts + 1
      WHERE token_hash = ${tokenHash} AND user_id = ${userId}::uuid AND purpose = 'mfa_challenge'
        AND used_at IS NULL AND expires_at > now() AND attempts < ${maxAttempts}
      RETURNING id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at`;
    return rows[0] ? out(rows[0]) : null;
  }

  async consume(id: string, userId: string, now: Date) {
    void now; // used_at and expiry use the database clock
    const rows = await this.db.$queryRaw<Row[]>`
      UPDATE mfa_challenges SET used_at = now()
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND purpose = 'mfa_challenge'
        AND used_at IS NULL AND expires_at > now()
        AND attempts > 0 AND attempts <= ${MFA_CHALLENGE_MAX_ATTEMPTS}
      RETURNING id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at`;
    return rows[0] ? out(rows[0]) : null;
  }

  async recordFailure(id: string, now: Date, maxAttempts: number) {
    void now; // used_at and expiry use the database clock
    // Increment already happened in reserveAttempt. Only burn at the cap, and only a still-live row.
    // A burned or expired row is not updated, so attempts cannot keep climbing after a burn.
    const rows = await this.db.$queryRaw<{ attempts: number }[]>`
      UPDATE mfa_challenges
      SET used_at = now()
      WHERE id = ${id}::uuid AND used_at IS NULL AND expires_at > now() AND attempts >= ${maxAttempts}
      RETURNING attempts`;
    if (rows[0]) return rows[0].attempts;
    const existing = await this.db.$queryRaw<{ attempts: number }[]>`
      SELECT attempts FROM mfa_challenges WHERE id = ${id}::uuid`;
    return existing[0]?.attempts ?? maxAttempts;
  }

  async invalidateForUser(userId: string, now: Date) {
    void now; // used_at is stamped with the database clock
    await this.db.$executeRaw`
      UPDATE mfa_challenges SET used_at = now()
      WHERE user_id = ${userId}::uuid AND used_at IS NULL`;
  }
}
