import { getPrismaClient, type DatabaseClient } from '../../../shared/prisma/context.js';
import type { MfaChallenge, MfaChallengeRepository, MfaFirstFactor } from '../domain/challenge.js';

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
 * mfa_challenges (ADR-021 OQ-17; global table like password_resets, no RLS). Single use and the attempt cap are one
 * conditional UPDATE each, so concurrent requests and API instances cannot both win.
 */
export class PrismaMfaChallengeRepository implements MfaChallengeRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}

  async create(c: MfaChallenge) {
    await this.db.mfaChallenge.create({
      data: {
        id: c.id,
        userId: c.userId,
        purpose: c.purpose,
        firstFactor: c.firstFactor,
        tokenHash: c.tokenHash,
        attempts: c.attempts,
        expiresAt: c.expiresAt,
        usedAt: c.usedAt,
        createdAt: c.createdAt,
      },
    });
  }

  async findLive(tokenHash: string, now: Date) {
    const rows = await this.db.$queryRaw<Row[]>`
      SELECT id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at
      FROM mfa_challenges
      WHERE token_hash = ${tokenHash} AND purpose = 'mfa_challenge' AND used_at IS NULL AND expires_at > ${now}`;
    return rows[0] ? out(rows[0]) : null;
  }

  async consume(id: string, userId: string, now: Date) {
    const rows = await this.db.$queryRaw<Row[]>`
      UPDATE mfa_challenges SET used_at = ${now}
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND purpose = 'mfa_challenge'
        AND used_at IS NULL AND expires_at > ${now}
      RETURNING id, user_id, purpose, first_factor, token_hash, attempts, expires_at, used_at, created_at`;
    return rows[0] ? out(rows[0]) : null;
  }

  async recordFailure(id: string, now: Date, maxAttempts: number) {
    const rows = await this.db.$queryRaw<{ attempts: number }[]>`
      UPDATE mfa_challenges
      SET attempts = attempts + 1,
          used_at = CASE WHEN attempts + 1 >= ${maxAttempts} THEN coalesce(used_at, ${now}) ELSE used_at END
      WHERE id = ${id}::uuid
      RETURNING attempts`;
    return rows[0]?.attempts ?? maxAttempts;
  }

  async invalidateForUser(userId: string, now: Date) {
    await this.db.mfaChallenge.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
  }
}
