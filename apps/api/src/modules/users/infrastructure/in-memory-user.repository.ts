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
  async create(user: User) {
    if (await this.findByEmail(user.email)) throw new DuplicateEmailError();
    this.byId.set(user.id, { ...user });
    return user;
  }
  async updatePasswordHash(id: UserId, passwordHash: string) {
    const u = this.byId.get(id);
    if (u) u.passwordHash = passwordHash;
  }
}
