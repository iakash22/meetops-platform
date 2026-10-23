import type { User, UserId } from './user.js';

/** users is a global (non-tenant) table. Implementations must exclude soft-deleted rows. */
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  /** Email must already be normalized. */
  findByEmail(email: string): Promise<User | null>;
  /** Must reject (DuplicateEmailError) when the email is taken. */
  create(user: User): Promise<User>;
  updatePasswordHash(id: UserId, passwordHash: string): Promise<void>;
}
