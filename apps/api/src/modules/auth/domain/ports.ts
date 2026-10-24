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

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/** Fixed-window counter. Redis adapter in production, in-memory in tests. */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

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
