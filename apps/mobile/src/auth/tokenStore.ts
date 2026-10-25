import type { MobileAuthTokens } from './types';

/**
 * Where the app keeps the bearer pair between launches.
 *
 * Plan M2 / R5 require the Keychain (iOS) and Keystore (Android) via `expo-secure-store`. That package is NOT a
 * dependency yet, and this PR must not touch the lockfile, so the app currently uses `createInMemoryTokenStore()`:
 * tokens live only in JS memory and a cold start means signing in again. FOLLOW-UP: add `expo-secure-store` (SDK 52:
 * `~14.0.x`) in a lockfile-owning PR and implement `TokenStore` with it (`keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`).
 *
 * Rules for every implementation:
 * - never AsyncStorage, files, or anything that is backed up in plain text;
 * - never log the stored value;
 * - `clear()` must succeed even when nothing is stored (it runs in the logout wipe).
 */
export interface TokenStore {
  load(): Promise<MobileAuthTokens | null>;
  save(tokens: MobileAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

/** Process-memory store. Safe default until secure storage lands; nothing survives an app restart. */
export function createInMemoryTokenStore(initial: MobileAuthTokens | null = null): TokenStore {
  let current: MobileAuthTokens | null = initial ? { ...initial } : null;
  return {
    load: () => Promise.resolve(current ? { ...current } : null),
    save: (tokens) => {
      current = { ...tokens };
      return Promise.resolve();
    },
    clear: () => {
      current = null;
      return Promise.resolve();
    },
  };
}
