import { getPrismaClient, type DatabaseClient } from '../../../../shared/prisma/context.js';
import type { OneTimeToken, OneTimeTokenPurpose, OneTimeTokenRepository } from '../../domain/one-time-token.js';

type Row = { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date };
const out = (purpose: OneTimeTokenPurpose, r: Row): OneTimeToken => ({ ...r, purpose });

/**
 * email_verifications / password_resets (DB #35, global tables). consume() is a single
 * `UPDATE ... WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now RETURNING` (D4),
 * so concurrent consumers cannot both win.
 */
export class PrismaOneTimeTokenRepository implements OneTimeTokenRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}

  async create(t: OneTimeToken) {
    const base = { id: t.id, userId: t.userId, tokenHash: t.tokenHash, expiresAt: t.expiresAt, usedAt: t.usedAt, createdAt: t.createdAt };
    if (t.purpose === 'password_reset') {
      await this.db.passwordReset.create({ data: base });
    } else {
      const u = await this.db.user.findFirstOrThrow({ where: { id: t.userId }, select: { email: true } });
      await this.db.emailVerification.create({ data: { ...base, email: u.email } });
    }
    return t;
  }
  async findById(id: string) {
    const r = await this.db.passwordReset.findUnique({ where: { id } });
    if (r) return out('password_reset', r);
    const v = await this.db.emailVerification.findUnique({ where: { id } });
    return v ? out('email_verification', v) : null;
  }
  async setTokenHash(id: string, tokenHash: string) {
    const n = await this.db.passwordReset.updateMany({ where: { id, usedAt: null }, data: { tokenHash } });
    if (n.count === 0) await this.db.emailVerification.updateMany({ where: { id, usedAt: null }, data: { tokenHash } });
  }
  async consume(purpose: OneTimeTokenPurpose, tokenHash: string, now: Date) {
    const rows =
      purpose === 'password_reset'
        ? await this.db.$queryRaw<{ id: string; user_id: string; token_hash: string; expires_at: Date; used_at: Date; created_at: Date }[]>`
            UPDATE password_resets SET used_at = ${now}
            WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
            RETURNING id, user_id, token_hash, expires_at, used_at, created_at`
        : await this.db.$queryRaw<{ id: string; user_id: string; token_hash: string; expires_at: Date; used_at: Date; created_at: Date }[]>`
            UPDATE email_verifications SET used_at = ${now}
            WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
            RETURNING id, user_id, token_hash, expires_at, used_at, created_at`;
    const r = rows[0];
    return r
      ? { id: r.id, userId: r.user_id, purpose, tokenHash: r.token_hash, expiresAt: r.expires_at, usedAt: r.used_at, createdAt: r.created_at }
      : null;
  }
  async invalidateForUser(userId: string, purpose: OneTimeTokenPurpose, now: Date) {
    const where = { userId, usedAt: null };
    if (purpose === 'password_reset') await this.db.passwordReset.updateMany({ where, data: { usedAt: now } });
    else await this.db.emailVerification.updateMany({ where, data: { usedAt: now } });
  }
}
