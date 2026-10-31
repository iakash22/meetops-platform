import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { KEYCHAIN_OPTIONS, type SecureStoreLike } from './secureTokenStore';

/**
 * Stable per-install device id (ADR-005: a random UUID per install, bound to the refresh family as `deviceId`).
 * Generated once with a CSPRNG, kept in the Keychain / Keystore (device-only, not backed up), and NOT cleared on
 * sign-out, so the server can list and revoke this device. Not a secret; never derived from hardware identifiers.
 */
export const DEVICE_ID_KEY = 'meetops.device.id.v1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DeviceIdProvider {
  get(): Promise<string>;
}

export function createDeviceIdProvider(
  store: SecureStoreLike = SecureStore,
  randomUUID: () => string = Crypto.randomUUID,
): DeviceIdProvider {
  let cached: string | null = null;
  let inflight: Promise<string> | null = null;
  let ephemeral: string | null = null;
  return {
    get() {
      if (cached) return Promise.resolve(cached);
      inflight ??= (async () => {
        try {
          let id: string | null = null;
          let readFailed = false;
          try {
            id = await store.getItemAsync(DEVICE_ID_KEY, KEYCHAIN_OPTIONS);
          } catch {
            readFailed = true; // unreadable now (e.g. locked): the stored id may still exist, so never overwrite it
          }
          if (readFailed) {
            // In-memory id until the store is readable again; not persisted or cached, so the next get() re-reads.
            ephemeral ??= randomUUID().toLowerCase();
            if (!UUID_RE.test(ephemeral)) {
              ephemeral = null;
              throw new Error('Device id generator returned a non-v4 UUID.');
            }
            return ephemeral;
          }
          if (!id || !UUID_RE.test(id)) {
            id = randomUUID().toLowerCase();
            if (!UUID_RE.test(id)) throw new Error('Device id generator returned a non-v4 UUID.');
            try {
              await store.setItemAsync(DEVICE_ID_KEY, id, KEYCHAIN_OPTIONS);
            } catch {
              // Keep it in memory for this process; it stays stable for every call until restart.
            }
          }
          cached = id;
          return id;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
