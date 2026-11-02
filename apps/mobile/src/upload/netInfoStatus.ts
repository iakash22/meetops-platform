import type { NetworkStatus } from './types';

/** The part of `@react-native-community/netinfo` this uses (kept narrow so tests can fake it). */
export interface NetInfoStateLike {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}
export interface NetInfoLike {
  addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
}

export interface WatchedNetworkStatus extends NetworkStatus {
  /** Called with `true` when the device comes back online, `false` when it goes offline (changes only). */
  onChange(listener: (online: boolean) => void): () => void;
  stop(): void;
}

/**
 * Offline = no connection, or a connection NetInfo has confirmed can't reach the internet. While the reachability
 * check hasn't finished (`null`), we count the device as online and let the request decide (backoff on failure).
 * Before the first NetInfo event we also count it as online, as before NetInfo existed.
 */
export const isOnlineState = (s: NetInfoStateLike): boolean =>
  s.isConnected !== false && s.isInternetReachable !== false;

export function createNetInfoStatus(netInfo: NetInfoLike): WatchedNetworkStatus {
  let online = true;
  const listeners = new Set<(online: boolean) => void>();
  const unsubscribe = netInfo.addEventListener((state) => {
    const next = isOnlineState(state);
    if (next === online) return;
    online = next;
    listeners.forEach((l) => l(next));
  });
  return {
    isOnline: () => online,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      listeners.clear();
      unsubscribe();
    },
  };
}

/** Live mode only: loads the native NetInfo module lazily so demo mode and Jest never touch it. */
export function loadNetInfo(): NetInfoLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@react-native-community/netinfo') as { default: NetInfoLike };
  return mod.default;
}
