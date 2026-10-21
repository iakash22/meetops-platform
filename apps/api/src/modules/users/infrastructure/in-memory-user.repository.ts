import type { User, UserId } from '../domain/user.js';
import type { UserRepository } from '../domain/user.repository.js';
import { DuplicateEmailError } from '../domain/errors.js';

/** Test/dev only. The Prisma implementation will replace this. */
export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<UserId, User>();

  async findById(id: UserId) {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: string) {
    for (const u of this.byId.values()) if (u.email === email) return u;
    return null;
  }

  async create(user: User) {
    if (await this.findByEmail(user.email)) throw new DuplicateEmailError();
    this.byId.set(user.id, { ...user });
    return user;
  }
}
