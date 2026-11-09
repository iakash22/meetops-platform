export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  /** True when the stored hash uses outdated parameters. */
  needsRehash(hash: string): boolean;
}

export interface TokenService {
  /** 256-bit CSPRNG, URL-safe opaque token. */
  generate(): string;
  /** Deterministic one-way hash (SHA-256 hex) used for lookup. */
  hash(token: string): string;
}

/** The rate-limit port is platform code (shared/rate-limit-core.ts); re-exported for existing auth imports. */
export type { RateLimiter, RateLimitResult } from '../../../shared/rate-limit-core.js';

/** Account lockout after repeated failures. Never permanent. */
export interface LoginLockout {
  isLocked(accountKey: string): Promise<{ locked: boolean; retryAfterMs: number }>;
  /**
   * Returns the lock started by this failure and the progressive delay to apply before
   * answering (0 when none). Callers must answer with the same generic error either way.
   */
  recordFailure(accountKey: string): Promise<{ lockedForMs: number; delayMs: number }>;
  reset(accountKey: string): Promise<void>;
}

/**
 * OIDC review X1: a takeover of a never-verified account (the mailbox owner wins) changes the account's credentials and
 * revokes every web session of it. Both must commit together: if the revocation could fail after the credential
 * change, the squatter's session would survive while later sign-ins take the "already linked" path and never revoke.
 * Implementations make each method all-or-nothing (Postgres: one transaction) and return false, changing nothing,
 * when the precondition (live, still unverified, and for Google still unlinked) no longer holds.
 */
export interface AccountClaimStore {
  /** Link `sub`, mark verified at `at`, drop the password; revoke every session of the account. */
  claimForGoogle(userId: string, sub: string, at: Date): Promise<boolean>;
  /** Mark verified at `at`, drop the password and any Google subject; revoke every session of the account. */
  claimForMailbox(userId: string, at: Date): Promise<boolean>;
}
