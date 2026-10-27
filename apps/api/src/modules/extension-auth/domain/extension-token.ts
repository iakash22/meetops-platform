import type { ExtensionScope } from '@meetops/contracts';

/** ADR-005 A1.1.3: single-use pairing code, stored by hash, bound to (nonce, extensionId, deviceId, user, org). */
export interface PairingRecord {
  codeHash: string;
  nonce: string;
  extensionId: string;
  deviceId: string;
  deviceLabel: string | null;
  userId: string;
  organizationId: string;
  expiresAt: Date;
}

/** ADR-005 A1.2: a refresh family, one per paired device. Rotation never extends `maxExpiresAt`. */
export interface TokenFamily {
  id: string;
  userId: string;
  organizationId: string;
  extensionId: string;
  deviceId: string;
  deviceLabel: string | null;
  scopes: ExtensionScope[];
  createdAt: Date;
  /** pairing time + EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS. */
  maxExpiresAt: Date;
  revokedAt: Date | null;
}

/** An issued access token, stored by SHA-256 hash only. */
export interface AccessTokenRecord {
  familyId: string;
  userId: string;
  organizationId: string;
  scopes: ExtensionScope[];
  expiresAt: Date;
}

/** Result of presenting a refresh token. `reused`: it was already consumed (A1.2.3 reuse detection). */
export type RefreshConsumeResult =
  | { status: 'ok'; familyId: string }
  | { status: 'reused'; familyId: string }
  | { status: 'unknown' };

/**
 * ADR-005 A1.2 token store. Only hashes are ever passed in; plaintext tokens never reach the store.
 * `consumePairing` and `consumeRefresh` MUST be atomic (single consumer).
 */
export interface ExtensionTokenRepository {
  savePairing(p: PairingRecord): Promise<void>;
  /** Atomically removes and returns the pairing; null when unknown or already used. Expiry is checked by the caller. */
  consumePairing(codeHash: string): Promise<PairingRecord | null>;
  createFamily(f: TokenFamily): Promise<void>;
  findFamily(id: string): Promise<TokenFamily | null>;
  /** Live (unrevoked, unexpired) families of a user, optionally in one org. */
  listFamilies(userId: string, now: Date, organizationId?: string): Promise<TokenFamily[]>;
  revokeFamily(id: string, at: Date): Promise<void>;
  /** Issues a refresh token hash for a family; it stays valid until consumed or the family ends. */
  saveRefresh(tokenHash: string, familyId: string, expiresAt: Date): Promise<void>;
  consumeRefresh(tokenHash: string): Promise<RefreshConsumeResult>;
  /** Read without consuming (revoke uses it). */
  peekRefresh(tokenHash: string): Promise<RefreshConsumeResult>;
  saveAccess(tokenHash: string, rec: AccessTokenRecord): Promise<void>;
  findAccess(tokenHash: string): Promise<AccessTokenRecord | null>;
}
