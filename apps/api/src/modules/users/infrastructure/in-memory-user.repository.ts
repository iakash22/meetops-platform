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
  async findByGoogleSub(sub: string) {
    for (const u of this.byId.values()) if (u.googleSub === sub && !u.deletedAt) return u;
    return null;
  }
  async linkGoogleSub(id: UserId, sub: string) {
    const u = this.byId.get(id);
    if (!u || u.deletedAt || u.googleSub) return false;
    if (await this.findByGoogleSub(sub)) return false;
    u.googleSub = sub;
    return true;
  }
  async claimUnverifiedForGoogle(id: UserId, sub: string, at: Date) {
    const u = this.byId.get(id);
    if (!u || u.deletedAt || u.googleSub || u.emailVerifiedAt) return false;
    if (await this.findByGoogleSub(sub)) return false;
    u.googleSub = sub;
    u.emailVerifiedAt = at;
    u.passwordHash = '';
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
