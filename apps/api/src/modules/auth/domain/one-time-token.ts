export type OneTimeTokenPurpose = 'email_verification' | 'password_reset';

/** Single-use token row. Only SHA-256(token) is stored; the raw token only exists in the email. */
export interface OneTimeToken {
  id: string;
  userId: string;
  purpose: OneTimeTokenPurpose;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface OneTimeTokenRepository {
  create(t: OneTimeToken): Promise<OneTimeToken>;
  findById(id: string): Promise<OneTimeToken | null>;
  /** Worker mints the real token: replaces the hash, invalidating any earlier link for this row. */
  setTokenHash(id: string, tokenHash: string): Promise<void>;
  /**
   * Atomic single use: `UPDATE ... SET used_at = now WHERE token_hash = $1 AND purpose = $2
   * AND used_at IS NULL AND expires_at > now RETURNING *`. Null when unknown/used/expired.
   */
  consume(purpose: OneTimeTokenPurpose, tokenHash: string, now: Date): Promise<OneTimeToken | null>;
  /** Marks every outstanding token of this purpose for the user as used. */
  invalidateForUser(userId: string, purpose: OneTimeTokenPurpose, now: Date): Promise<void>;
  /** True when the user has a token of this purpose created at or after `since` that is still unused and unexpired. */
  hasUnusedSince(
    userId: string,
    purpose: OneTimeTokenPurpose,
    since: Date,
    now: Date,
  ): Promise<boolean>;
}
