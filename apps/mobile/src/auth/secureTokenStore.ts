import * as SecureStore from 'expo-secure-store';

import type { TokenStore } from './tokenStore';
import type { MobileAuthTokens } from './types';

/**
 * Keychain (iOS) / Keystore (Android) item, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: device-only (never synced or
 * restored to another device) and writable while the phone is locked once it has been unlocked after boot, so a
 * background refresh can persist the rotated refresh token (M-1). Android backup is disabled in app.config.ts.
 *
 * Only the refresh half is persisted. The access token lives in process memory only; after a cold start the session
 * manager sees an expired access token and refreshes.
 *
 * Write failures (e.g. keychain unavailable before first unlock): the new pair stays in memory and is served by `load()`,
 * and the write is retried on every later `load()`/`save()` until it succeeds. A rotated refresh token is therefore never
 * lost while the process lives, so the next refresh does not present the old (revoked) token and trip reuse detection.
 */
export const TOKEN_KEY = 'meetops.auth.tokens.v1';

export const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
const OPTIONS = KEYCHAIN_OPTIONS;

/** Minimal surface of expo-secure-store, injectable for tests. */
export interface SecureStoreLike {
  getItemAsync: (key: string, options?: SecureStore.SecureStoreOptions) => Promise<string | null>;
  setItemAsync: (
    key: string,
    value: string,
    options?: SecureStore.SecureStoreOptions,
  ) => Promise<void>;
  deleteItemAsync: (key: string, options?: SecureStore.SecureStoreOptions) => Promise<void>;
}

/** Thrown by `load()` when the keychain cannot be read (locked before first unlock). Not an auth failure: keep state. */
export class KeychainUnavailableError extends Error {
  constructor() {
    super('Secure storage is unavailable (device locked?).');
    this.name = 'KeychainUnavailableError';
  }
}

type PersistedTokens = Pick<
  MobileAuthTokens,
  'tokenType' | 'refreshToken' | 'refreshExpiresAt' | 'organizationId'
>;

function isPersisted(v: unknown): v is PersistedTokens {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  return (
    t.tokenType === 'Bearer' &&
    ['refreshToken', 'refreshExpiresAt', 'organizationId'].every(
      (k) => typeof t[k] === 'string' && (t[k] as string).length > 0,
    )
  );
}

const toPersisted = (t: MobileAuthTokens): PersistedTokens => ({
  tokenType: t.tokenType,
  refreshToken: t.refreshToken,
  refreshExpiresAt: t.refreshExpiresAt,
  organizationId: t.organizationId,
});

/** A persisted pair rehydrated without an access token: already expired, so the next use refreshes. */
const rehydrate = (p: PersistedTokens): MobileAuthTokens => ({
  ...p,
  accessToken: '',
  expiresAt: new Date(0).toISOString(),
});

/**
 * Plan M2 / R5 token store. Never logs the value. A corrupt or foreign item is deleted and treated as signed out.
 * `clear()` tolerates a missing item (it runs in the logout wipe).
 */
export function createSecureTokenStore(store: SecureStoreLike = SecureStore): TokenStore {
  let memory: MobileAuthTokens | null = null;
  let pendingWrite = false;

  const persist = async (): Promise<void> => {
    if (!memory) return;
    try {
      await store.setItemAsync(TOKEN_KEY, JSON.stringify(toPersisted(memory)), OPTIONS);
      pendingWrite = false;
    } catch {
      pendingWrite = true; // keep in memory, retry later
    }
  };

  return {
    async load() {
      if (memory) {
        if (pendingWrite) await persist();
        return { ...memory };
      }
      let raw: string | null;
      try {
        raw = await store.getItemAsync(TOKEN_KEY, OPTIONS);
      } catch {
        throw new KeychainUnavailableError();
      }
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isPersisted(parsed)) {
          memory = rehydrate(parsed);
          return { ...memory };
        }
      } catch {
        // fall through: unreadable item
      }
      await store.deleteItemAsync(TOKEN_KEY, OPTIONS);
      return null;
    },
    async save(tokens) {
      memory = { ...tokens };
      await persist();
    },
    async clear() {
      memory = null;
      pendingWrite = false;
      try {
        await store.deleteItemAsync(TOKEN_KEY, OPTIONS);
      } catch {
        // Nothing stored, or already gone: the wipe must still succeed.
      }
    },
  };
}
