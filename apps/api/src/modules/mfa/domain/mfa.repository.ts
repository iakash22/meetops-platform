/** ADR-021 MFA storage port. Every method is scoped to one user (Prisma: forced RLS on app.current_user_id). */
export type MfaFactorStatus = 'pending' | 'active';

export interface MfaFactorRecord {
  id: string;
  userId: string;
  type: 'totp';
  status: MfaFactorStatus;
  /** TokenCipher envelope of the MfaSecretPayload (AAD = user + factor). */
  secretEnc: string;
  secretKeyId: string;
  /** RFC 6238 replay guard: highest accepted time step. */
  lastUsedStep: number | null;
  pendingExpiresAt: Date | null;
  confirmedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ActivateFactorInput {
  userId: string;
  factorId: string;
  /** The TOTP step the confirm code matched; stored as lastUsedStep. */
  step: number;
  at: Date;
  recoveryHashes: string[];
}

export interface MfaRepository {
  listFactors(userId: string): Promise<MfaFactorRecord[]>;
  findFactor(userId: string, factorId: string): Promise<MfaFactorRecord | null>;
  findActiveTotp(userId: string): Promise<MfaFactorRecord | null>;
  /** Insert a pending factor, dropping the user's other pending (never active) factors in the same unit. */
  createPending(factor: MfaFactorRecord): Promise<void>;
  /**
   * One unit: the pending, unexpired factor becomes active (lastUsedStep = step), any previously active TOTP factor of
   * the user is deleted (replacement, its recovery codes cascade), the recovery hashes are stored, and
   * users.mfa_enabled_at is set if it was null. False (nothing changed) when the precondition no longer holds.
   */
  activate(input: ActivateFactorInput): Promise<boolean>;
  /** Replay guard CAS: lastUsedStep := step only when it is null or lower and the factor is active. */
  advanceStep(userId: string, factorId: string, step: number, at: Date): Promise<boolean>;
  /** Single-use CAS: marks the unused code with this hash as used. False when unknown or already used. */
  consumeRecoveryCode(
    userId: string,
    factorId: string,
    codeHash: string,
    at: Date,
  ): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string, factorId: string): Promise<number>;
  /**
   * One unit: replaces every recovery code of the factor with `hashes` and stores the re-encrypted payload (new
   * recovery key). False when the factor is not active.
   */
  replaceRecoveryCodes(
    userId: string,
    factorId: string,
    secretEnc: string,
    secretKeyId: string,
    hashes: string[],
  ): Promise<boolean>;
  /**
   * One unit: deletes the factor (codes cascade) and clears users.mfa_enabled_at when no active factor is left. False
   * when the factor does not exist for this user.
   */
  deleteFactor(userId: string, factorId: string): Promise<boolean>;
}
