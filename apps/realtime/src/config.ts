export type RealtimeConfig = {
  host: string;
  port: number;
  /** When set, the Socket.IO Redis adapter is enabled. */
  redisUrl?: string;
  /** Comma-separated allowed CORS origins; "*" or empty allows any. */
  corsOrigins: string[] | '*';
  path: string;
};

export function loadRealtimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const port = Number(env.REALTIME_PORT ?? 4001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid REALTIME_PORT: ${env.REALTIME_PORT}`);
  const origins = (env.REALTIME_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const cfg: RealtimeConfig = {
    host: env.REALTIME_HOST || '0.0.0.0',
    port,
    corsOrigins: origins.length === 0 || origins.includes('*') ? '*' : origins,
    path: env.REALTIME_SOCKET_PATH || '/socket.io'
  };
  if (env.REDIS_URL) cfg.redisUrl = env.REDIS_URL;
  return cfg;
}
