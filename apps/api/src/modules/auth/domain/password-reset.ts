export interface PasswordResetToken {
  id: string;
  userId: string;
  /** SHA-256 of the reset token. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface PasswordResetRepository {
  create(t: PasswordResetToken): Promise<PasswordResetToken>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetToken | null>;
  markUsed(id: string, at: Date): Promise<void>;
}

export function isResetTokenUsable(t: PasswordResetToken, now: Date): boolean {
  return t.usedAt === null && t.expiresAt.getTime() > now.getTime();
}
