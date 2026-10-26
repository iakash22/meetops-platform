import type { MobileAuthTokens } from './types';

/**
 * Where the app keeps the bearer pair between launches.
 *
 * Production uses `createSecureTokenStore()` (expo-secure-store, Keychain / Keystore, Plan M2 / R5). The in-memory store
 * below is for tests and previews.
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
