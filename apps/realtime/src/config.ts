export type RealtimeConfig = {
  host: string;
  port: number;
  /** When set, the Socket.IO Redis adapter is enabled. */
  redisUrl?: string;
  /** Allowed browser origins (REALTIME_CORS_ORIGINS, required, no wildcard). Also enforced at the handshake. */
  corsOrigins: string[];
  path: string;
};

export function loadRealtimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const port = Number(env.REALTIME_PORT ?? 4001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid REALTIME_PORT: ${env.REALTIME_PORT}`);
  const origins = (env.REALTIME_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error('REALTIME_CORS_ORIGINS is required (comma-separated origins)');
  for (const o of origins) {
    if (o === '*' || o === 'null' || normalizeOrigin(o) !== o.replace(/\/$/, '').toLowerCase()) {
      throw new Error('REALTIME_CORS_ORIGINS must list exact origins like https://app.example.com (no wildcard, path or query)');
    }
  }
  const cfg: RealtimeConfig = {
    host: env.REALTIME_HOST || '0.0.0.0',
    port,
    corsOrigins: origins.map((o) => normalizeOrigin(o)!),
    path: env.REALTIME_SOCKET_PATH || '/socket.io'
  };
  if (env.REDIS_URL) cfg.redisUrl = env.REDIS_URL;
  return cfg;
}

/** Canonical `scheme://host[:port]` for an http(s) origin, or null if it is not a plain origin. */
export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}
