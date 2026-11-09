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
  /**
   * OIDC review N-1: Google proved the address of an account whose email was never verified, so whoever set its
   * password may not own the mailbox. In ONE update, only while the row is live, unverified and unlinked: drop the
   * password, mark the email verified at `at`, and set googleSub. Returns false when any condition no longer holds or
   * the subject belongs to someone else.
   */
  claimUnverifiedForGoogle(id: UserId, sub: string, at: Date): Promise<boolean>;
  /**
   * OIDC review N-1 residual / N-7: the mailbox owner proved the address (verification or reset link) from outside the
   * account. In ONE update, only while the row is live and still unverified: mark the email verified at `at`, drop any
   * Google subject (it never proved this address) and, with `clearPassword`, the password whoever registered set.
   * Returns false when the row is gone or already verified (nothing changed).
   */
  claimUnverifiedForMailbox(
    id: UserId,
    at: Date,
    opts: { clearPassword: boolean },
  ): Promise<boolean>;
  /** Must reject (DuplicateEmailError) when the email is taken. */
  create(user: User): Promise<User>;
  updatePasswordHash(id: UserId, passwordHash: string): Promise<void>;
  markEmailVerified(id: UserId, at: Date): Promise<void>;
}
