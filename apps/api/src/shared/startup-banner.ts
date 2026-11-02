/**
 * Human-readable startup banner printed once after listen().
 * Never logs secrets: connection targets are host/port/db-name only.
 */

export type ReadinessOutcome = 'ok' | 'fail' | 'timeout' | 'skipped' | 'n/a';

export interface StartupBannerInput {
  /** Listen address from Fastify (e.g. http://127.0.0.1:3000). */
  address: string;
  /** process.env.NODE_ENV (or override). */
  nodeEnv?: string | undefined;
  /** WEB_BASE_URL for the SPA. */
  webBaseUrl?: string | undefined;
  /** Package version string. */
  version?: string | undefined;
  /** Outcome map from GET /ready (names: database, redis, …). */
  checks?: Record<string, ReadinessOutcome | string> | undefined;
  /** Whether /ready reported ready. */
  ready?: boolean | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

const WIDTH = 66;

function pad(label: string, value: string, width = WIDTH): string {
  const left = `  ${label}`;
  const gap = Math.max(1, width - left.length - value.length - 2);
  return `${left}${' '.repeat(gap)}${value}`;
}

function line(char = '=', width = WIDTH): string {
  return char.repeat(width);
}

function statusWord(outcome: ReadinessOutcome | string | undefined, configured: boolean): string {
  if (!configured) return 'OFF';
  if (!outcome || outcome === 'n/a' || outcome === 'skipped') return 'CONFIGURED';
  if (outcome === 'ok') return 'CONNECTED';
  if (outcome === 'timeout') return 'TIMEOUT';
  if (outcome === 'fail') return 'FAILED';
  return String(outcome).toUpperCase();
}

/** Strip credentials; keep host:port/path for operators. */
export function safeConnectionTarget(raw: string | undefined): string {
  if (!raw?.trim()) return '—';
  try {
    const withScheme = raw.includes('://') ? raw : `scheme://${raw}`;
    const u = new URL(withScheme);
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    const host = u.hostname || 'localhost';
    return `${host}${port}${path}`;
  } catch {
    return 'configured';
  }
}

function flag(env: Record<string, string | undefined>, key: string): boolean {
  const v = (env[key] ?? '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(v);
}

function emailMode(env: Record<string, string | undefined>): string {
  const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (provider) return provider;
  if (env.SMTP_HOST?.trim()) return 'smtp';
  if (env.RESEND_API_KEY?.trim()) return 'resend';
  return 'console (dev)';
}

function mailQueueMode(env: Record<string, string | undefined>): string {
  const mode = (env.AUTH_MAIL_QUEUE ?? '').trim().toLowerCase();
  if (mode === 'bullmq') return 'bullmq';
  return 'inline';
}

/**
 * Build a multi-line banner. Safe to print with console.log (UTF-8 box drawing).
 */
export function formatStartupBanner(input: StartupBannerInput): string {
  const env = input.env ?? process.env;
  const nodeEnv = input.nodeEnv ?? env.NODE_ENV ?? 'development';
  const web = input.webBaseUrl ?? env.WEB_BASE_URL ?? 'http://localhost:5173';
  const version = input.version ?? '0.0.0';
  const checks = input.checks ?? {};

  const hasDb = !!(env.DATABASE_URL ?? '').trim();
  const hasRedis = !!(env.REDIS_URL ?? '').trim();
  const mediaOn = flag(env, 'MEDIA_STORAGE_ENABLED');
  const desktopOn = flag(env, 'DESKTOP_AUTH_ENABLED');
  const metricsOn = !!(env.METRICS_TOKEN ?? '').trim();
  const docsOn = nodeEnv === 'development' || nodeEnv === 'test';
  const ready =
    input.ready === undefined
      ? Object.values(checks).every((c) => c === 'ok' || c === undefined)
      : input.ready;

  const headline = ready ? 'READY' : 'DEGRADED';
  const dbOutcome =
    (checks.database as ReadinessOutcome | undefined) ?? (hasDb ? 'n/a' : 'skipped');
  const redisOutcome =
    (checks.redis as ReadinessOutcome | undefined) ?? (hasRedis ? 'n/a' : 'skipped');

  const rows: string[] = [
    line('='),
    pad('MeetOps AI API', `v${version}`),
    pad('Status', headline),
    line('-'),
    pad('Listen', input.address),
    pad('Env', nodeEnv),
    pad('Web app', web),
    line('-'),
    pad(
      'Database',
      `${statusWord(dbOutcome, hasDb)}  ${hasDb ? safeConnectionTarget(env.DATABASE_URL) : 'not configured'}`,
    ),
    pad(
      'Redis',
      `${statusWord(redisOutcome, hasRedis)}  ${hasRedis ? safeConnectionTarget(env.REDIS_URL) : 'not configured'}`,
    ),
    pad(
      'Media storage',
      mediaOn ? 'ENABLED   S3/MinIO (MEDIA_STORAGE_ENABLED)' : 'OFF       in-memory / disabled',
    ),
    pad('Mail transport', emailMode(env)),
    pad('Auth mail queue', mailQueueMode(env)),
    pad('Desktop auth', desktopOn ? 'ENABLED' : 'OFF'),
    pad('Metrics', metricsOn ? 'ENABLED   GET /metrics (token)' : 'OFF'),
    pad('OpenAPI docs', docsOn ? 'GET /docs' : 'hidden (non-dev)'),
    pad('Health', 'GET /health'),
    pad('Ready', 'GET /ready'),
    line('='),
  ];

  return `\n${rows.join('\n')}\n`;
}

/** Print banner to stdout and return the same string. */
export function printStartupBanner(input: StartupBannerInput): string {
  const text = formatStartupBanner(input);
  // eslint-disable-next-line no-console -- intentional operator-facing banner
  console.log(text);
  return text;
}
