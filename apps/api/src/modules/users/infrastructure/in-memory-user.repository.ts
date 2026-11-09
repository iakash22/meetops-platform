import type { User, UserId } from '../domain/user.js';
import type { UserRepository } from '../domain/user.repository.js';
import { DuplicateEmailError } from '../domain/errors.js';

/** Test/dev only. The Prisma implementation will replace this. */
export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<UserId, User>();

  async findById(id: UserId) {
    const u = this.byId.get(id);
    return u && !u.deletedAt ? u : null;
  }
  async findByEmail(email: string) {
    for (const u of this.byId.values()) if (u.email === email && !u.deletedAt) return u;
    return null;
  }
  private subTaken(sub: string) {
    for (const u of this.byId.values()) if (u.googleSub === sub && !u.deletedAt) return true;
    return false;
  }
  async findByGoogleSub(sub: string) {
    for (const u of this.byId.values()) if (u.googleSub === sub && !u.deletedAt) return u;
    return null;
  }
  async linkGoogleSub(id: UserId, sub: string) {
    const u = this.byId.get(id);
    // No await between the checks and the write: like the Prisma conditional update, this must be atomic.
    if (!u || u.deletedAt || u.googleSub || this.subTaken(sub)) return false;
    u.googleSub = sub;
    return true;
  }
  async claimUnverifiedForGoogle(id: UserId, sub: string, at: Date) {
    const u = this.byId.get(id);
    if (!u || u.deletedAt || u.googleSub || u.emailVerifiedAt || this.subTaken(sub)) return false;
    u.googleSub = sub;
    u.emailVerifiedAt = at;
    u.passwordHash = '';
    return true;
  }
  async claimUnverifiedForMailbox(id: UserId, at: Date, opts: { clearPassword: boolean }) {
    const u = this.byId.get(id);
    if (!u || u.deletedAt || u.emailVerifiedAt) return false;
    u.emailVerifiedAt = at;
    u.googleSub = null;
    if (opts.clearPassword) u.passwordHash = '';
    return true;
  }
  async create(user: User) {
    if (await this.findByEmail(user.email)) throw new DuplicateEmailError();
    if (user.googleSub && (await this.findByGoogleSub(user.googleSub)))
      throw new DuplicateEmailError();
    this.byId.set(user.id, { ...user });
    return user;
  }
  async markEmailVerified(id: UserId, at: Date) {
    const u = this.byId.get(id);
    if (u && !u.emailVerifiedAt) u.emailVerifiedAt = at;
  }
  async updatePasswordHash(id: UserId, passwordHash: string) {
    const u = this.byId.get(id);
    if (u) u.passwordHash = passwordHash;
  }
}
