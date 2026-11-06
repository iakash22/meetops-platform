import type { User, UserId } from './user.js';

/** users is a global (non-tenant) table. Implementations must exclude soft-deleted rows. */
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  /** Email must already be normalized. */
  findByEmail(email: string): Promise<User | null>;
  /** Google OIDC subject. Excludes soft-deleted rows. */
  findByGoogleSub(sub: string): Promise<User | null>;
  /**
   * Sets googleSub only when it is still null. Returns false if the user is missing, already linked,
   * or the subject belongs to someone else. Must not clear or replace an existing subject.
   */
  linkGoogleSub(id: UserId, sub: string): Promise<boolean>;
  /** Must reject (DuplicateEmailError) when the email is taken. */
  create(user: User): Promise<User>;
  updatePasswordHash(id: UserId, passwordHash: string): Promise<void>;
  markEmailVerified(id: UserId, at: Date): Promise<void>;
}
