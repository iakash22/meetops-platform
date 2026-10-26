import * as SecureStore from 'expo-secure-store';

import type { TokenStore } from './tokenStore';
import type { MobileAuthTokens } from './types';

/**
 * Keychain (iOS) / Keystore (Android) item, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
 * LOCKED DEVICE: the item cannot be read or written while the phone is locked, so token refresh is blocked until the
 * user unlocks (calls reject; nothing is lost). We accept this over weaker AFTER_FIRST_UNLOCK access.
 *
 * Item: One item per install; never synced or backed up. */
export const TOKEN_KEY = 'meetops.auth.tokens.v1';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

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

function isTokens(v: unknown): v is MobileAuthTokens {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    t.tokenType === 'Bearer' &&
    ['accessToken', 'expiresAt', 'refreshToken', 'refreshExpiresAt', 'organizationId'].every(
      (k) => typeof t[k] === 'string' && (t[k] as string).length > 0,
    )
  );
}

/**
 * Plan M2 / R5 token store. Never logs the value. A corrupt or foreign item is deleted and treated as signed out.
 * `clear()` tolerates a missing item (it runs in the logout wipe).
 */
export function createSecureTokenStore(store: SecureStoreLike = SecureStore): TokenStore {
  return {
    async load() {
      const raw = await store.getItemAsync(TOKEN_KEY, OPTIONS);
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isTokens(parsed)) return parsed;
      } catch {
        // fall through: unreadable item
      }
      await store.deleteItemAsync(TOKEN_KEY, OPTIONS);
      return null;
    },
    save: (tokens) => store.setItemAsync(TOKEN_KEY, JSON.stringify(tokens), OPTIONS),
    async clear() {
      try {
        await store.deleteItemAsync(TOKEN_KEY, OPTIONS);
      } catch {
        // Nothing stored, or already gone: the wipe must still succeed.
      }
    },
  };
}
