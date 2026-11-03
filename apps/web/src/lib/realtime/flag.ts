/**
 * Realtime is off unless VITE_REALTIME_ENABLED is exactly 'true'. When off, nothing connects and the
 * app relies on polling alone (the previous behaviour).
 */
export function isRealtimeEnabled(env: ImportMetaEnv = import.meta.env): boolean {
  return env.VITE_REALTIME_ENABLED === 'true';
}

export type RealtimeEndpoint = { url?: string | undefined; path: string };

/** Realtime origin (VITE_REALTIME_URL, default same origin) and Socket.IO path (VITE_REALTIME_PATH). */
export function realtimeEndpoint(env: ImportMetaEnv = import.meta.env): RealtimeEndpoint {
  return { url: env.VITE_REALTIME_URL || undefined, path: env.VITE_REALTIME_PATH || '/socket.io' };
}
