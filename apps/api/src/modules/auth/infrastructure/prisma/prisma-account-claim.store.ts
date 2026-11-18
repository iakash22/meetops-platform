import {
  isUniqueViolation,
  withUserContext,
  type DatabaseClient,
} from '../../../../shared/prisma/context.js';
import type { AccountClaimStore } from '../../domain/ports.js';

/**
 * OIDC review X1: the credential change on `users` and the revocation of every `sessions` row of the account commit in
 * ONE Postgres transaction, so a failure anywhere leaves both untouched and the next attempt redoes the whole claim.
 *
 * ADR-001 note: this adapter writes `users.password_hash / email_verified_at / google_sub` from the auth module. Those
 * are the account's credential columns (the users module owns the row; auth already owns what they mean), and the
 * write is the same conditional update as PrismaUserRepository's claim methods. Both tables are global (no RLS,
 * ADR-010).
 *
 * ADR-021 OQ-15: the same transaction deletes every MFA factor (active or pending enrolment) and every recovery-code
 * hash of the account and clears users.mfa_enabled_at, so a takeover never inherits a squatter's second factor. The
 * MFA tables have user-scoped forced RLS, so the transaction runs with app.current_user_id set LOCAL to the account.
 */
export class PrismaAccountClaimStore implements AccountClaimStore {
  constructor(private readonly db: DatabaseClient) {}

  claimForGoogle(userId: string, sub: string, at: Date) {
    return this.claim(userId, at, { googleSub: null }, { googleSub: sub, passwordHash: null });
  }

  claimForMailbox(userId: string, at: Date) {
    return this.claim(userId, at, {}, { googleSub: null, passwordHash: null });
  }

  private async claim(
    userId: string,
    at: Date,
    where: { googleSub?: null },
    data: { googleSub: string | null; passwordHash: null },
  ): Promise<boolean> {
    try {
      return await withUserContext(
        userId,
        async (tx) => {
          const r = await tx.user.updateMany({
            where: { id: userId, deletedAt: null, emailVerified: null, ...where },
            data: { ...data, emailVerified: at, mfaEnabledAt: null },
          });
          if (r.count !== 1) return false;
          await tx.session.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: at },
          });
          await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
          await tx.mfaFactor.deleteMany({ where: { userId } });
          return true;
        },
        { client: this.db },
      );
    } catch (e) {
      // Another live account already holds this Google subject (partial unique index): nothing was committed.
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }
}
