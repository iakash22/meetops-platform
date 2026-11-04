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

/**
 * Warn (dev aid, no behaviour change) when VITE_REALTIME_URL points at another host than the page: the
 * HttpOnly session cookie is host-only, so a cross-host upgrade arrives without it and is refused. Prefer the
 * same-origin /socket.io proxy (Vite dev server, web nginx). Returns true when it warned.
 */
export function warnIfCrossHost(
  url: string | undefined,
  pageHost: string | undefined = globalThis.location?.host,
  warn: (msg: string) => void = (m) => console.warn(m),
): boolean {
  if (!url || !pageHost) return false;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return false;
  }
  if (host === pageHost) return false;
  warn(
    `[realtime] VITE_REALTIME_URL host "${host}" differs from the page host "${pageHost}": the session cookie will not be sent on the upgrade. Leave VITE_REALTIME_URL empty to use the same-origin /socket.io proxy.`,
  );
  return true;
}
