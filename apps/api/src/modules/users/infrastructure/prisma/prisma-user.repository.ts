import {
  getPrismaClient,
  isUniqueViolation,
  type DatabaseClient,
} from '../../../../shared/prisma/context.js';
import type { User, UserId } from '../../domain/user.js';
import type { UserRepository } from '../../domain/user.repository.js';
import { DuplicateEmailError } from '../../domain/errors.js';

type Row = {
  id: string;
  email: string;
  name: string | null;
  passwordHash: string | null;
  emailVerified: Date | null;
  googleSub: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};
const toUser = (r: Row): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  // Accounts without a password (Google-only) can never pass argon2 verify.
  passwordHash: r.passwordHash ?? '',
  emailVerifiedAt: r.emailVerified,
  googleSub: r.googleSub,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt,
});

/** users is global (no RLS); always excludes soft-deleted rows. */
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}
  async findById(id: UserId) {
    const r = await this.db.user.findFirst({ where: { id, deletedAt: null } });
    return r ? toUser(r) : null;
  }
  async findByEmail(email: string) {
    const r = await this.db.user.findFirst({ where: { email, deletedAt: null } });
    return r ? toUser(r) : null;
  }
  async findByGoogleSub(sub: string) {
    const r = await this.db.user.findFirst({ where: { googleSub: sub, deletedAt: null } });
    return r ? toUser(r) : null;
  }
  async linkGoogleSub(id: UserId, sub: string) {
    try {
      const r = await this.db.user.updateMany({
        where: { id, deletedAt: null, googleSub: null },
        data: { googleSub: sub },
      });
      return r.count === 1;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }
  async claimUnverifiedForGoogle(id: UserId, sub: string, at: Date) {
    try {
      const r = await this.db.user.updateMany({
        where: { id, deletedAt: null, googleSub: null, emailVerified: null },
        data: { googleSub: sub, emailVerified: at, passwordHash: null },
      });
      return r.count === 1;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }
  async claimUnverifiedForMailbox(id: UserId, at: Date, opts: { clearPassword: boolean }) {
    const r = await this.db.user.updateMany({
      where: { id, deletedAt: null, emailVerified: null },
      data: {
        emailVerified: at,
        googleSub: null,
        ...(opts.clearPassword ? { passwordHash: null } : {}),
      },
    });
    return r.count === 1;
  }
  async create(u: User) {
    try {
      const r = await this.db.user.create({
        data: {
          id: u.id,
          email: u.email,
          name: u.name,
          passwordHash: u.passwordHash || null,
          emailVerified: u.emailVerifiedAt,
          googleSub: u.googleSub ?? null,
          createdAt: u.createdAt,
        },
      });
      return toUser(r);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateEmailError();
      throw e;
    }
  }
  async updatePasswordHash(id: UserId, passwordHash: string) {
    await this.db.user.updateMany({ where: { id, deletedAt: null }, data: { passwordHash } });
  }
  async markEmailVerified(id: UserId, at: Date) {
    await this.db.user.updateMany({
      where: { id, deletedAt: null, emailVerified: null },
      data: { emailVerified: at },
    });
  }
}
