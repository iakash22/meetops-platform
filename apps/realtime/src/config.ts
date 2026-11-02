export type RealtimeConfig = {
  host: string;
  port: number;
  /** When set, the Socket.IO Redis adapter is enabled. */
  redisUrl?: string;
  /** Allowed browser origins (REALTIME_CORS_ORIGINS, required, no wildcard). Also enforced at the handshake. */
  corsOrigins: string[];
  /**
   * Allowed extension origins (`chrome-extension://<id>`, from REALTIME_EXTENSION_IDS). Bearer (extension) handshakes
   * are accepted only from these (ADR-011 section 1.3). Empty: no bearer handshake is accepted.
   */
  extensionOrigins: string[];
  /** Session cookie read on web handshakes: `__Host-meetops_sid`, or `meetops_sid` only when NODE_ENV=development. */
  sessionCookieName: string;
  path: string;
  /** Send HSTS on HTTP responses (NODE_ENV=production). */
  hsts?: boolean;
  /** Re-verify every live socket's credential this often (REALTIME_REVALIDATE_INTERVAL_MS, default 60 s, min 1 s). */
  revalidateIntervalMs: number;
  /** Connection attempts allowed per client IP per window (REALTIME_CONN_LIMIT_PER_IP, default 30). */
  connLimitPerIp: number;
  /** Authenticated connections allowed per user per window (REALTIME_CONN_LIMIT_PER_USER, default 20). */
  connLimitPerUser: number;
  /** Rate-limit window (REALTIME_CONN_LIMIT_WINDOW_MS, default 60 s). */
  connLimitWindowMs: number;
};

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`Invalid ${key}: must be an integer >= ${min}`);
  return n;
}

/** Chrome extension ids are 32 characters a-p. */
const EXTENSION_ID = /^[a-p]{32}$/;

export function loadRealtimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const port = Number(env.REALTIME_PORT ?? 4001);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`Invalid REALTIME_PORT: ${env.REALTIME_PORT}`);
  const origins = (env.REALTIME_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0)
    throw new Error('REALTIME_CORS_ORIGINS is required (comma-separated origins)');
  for (const o of origins) {
    if (o === '*' || o === 'null' || normalizeOrigin(o) !== o.replace(/\/$/, '').toLowerCase()) {
      throw new Error(
        'REALTIME_CORS_ORIGINS must list exact origins like https://app.example.com (no wildcard, path or query)',
      );
    }
  }
  const extensionIds = (env.REALTIME_EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of extensionIds) {
    if (!EXTENSION_ID.test(id))
      throw new Error('REALTIME_EXTENSION_IDS must list Chrome extension ids (32 characters a-p)');
  }
  const cfg: RealtimeConfig = {
    host: env.REALTIME_HOST || '0.0.0.0',
    port,
    corsOrigins: origins.map((o) => normalizeOrigin(o)!),
    extensionOrigins: extensionIds.map((id) => `chrome-extension://${id}`),
    sessionCookieName: env.NODE_ENV === 'development' ? 'meetops_sid' : '__Host-meetops_sid',
    path: env.REALTIME_SOCKET_PATH || '/socket.io',
    hsts: env.NODE_ENV === 'production',
    revalidateIntervalMs: positiveInt(env, 'REALTIME_REVALIDATE_INTERVAL_MS', 60_000, 1_000),
    connLimitPerIp: positiveInt(env, 'REALTIME_CONN_LIMIT_PER_IP', 30),
    connLimitPerUser: positiveInt(env, 'REALTIME_CONN_LIMIT_PER_USER', 20),
    connLimitWindowMs: positiveInt(env, 'REALTIME_CONN_LIMIT_WINDOW_MS', 60_000, 1_000),
  };
  if (env.REDIS_URL) cfg.redisUrl = env.REDIS_URL;
  return cfg;
}

/** Canonical `scheme://host[:port]` for an http(s) origin, or null if it is not a plain origin. */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
      return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Canonical `chrome-extension://<id>` origin, or null. */
export function normalizeExtensionOrigin(value: string): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})\/?$/i.exec(value.trim());
  return m ? `chrome-extension://${m[1]!.toLowerCase()}` : null;
}
