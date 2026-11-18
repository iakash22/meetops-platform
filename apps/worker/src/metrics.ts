import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  AUTH_TAKEOVER_FOLLOW_UP_DLQ,
  AUTH_TAKEOVER_FOLLOW_UP_QUEUE,
  MEDIA_QUEUE,
  NOTIFICATION_DELIVERY_QUEUE,
  QUEUE_NAMES,
  TASK_SYNC_QUEUE,
} from '@meetops/contracts';
import { createQueue } from '@meetops/queue';
import { TRANSCRIPTION_DLQ } from './ai/transcription-retry.js';
import { EMBEDDINGS_QUEUE } from './embeddings/pipeline.js';
import { logger } from './logger.js';

export type MetricsLog = { warn(obj: object, msg: string): void };
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopbackHost = (h: string) => LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);

/**
 * Worker queue-depth metrics (P9 item #13), Prometheus text format 0.0.4, no client library.
 *
 * `bullmq_queue_jobs{queue,state}` from BullMQ `getJobCounts`, plus `bullmq_queue_scrape_error{queue}` (1 when a
 * queue's counts could not be read, so a Redis outage is an alert, not a silent gap). Labels are fixed queue
 * names and states only: no job ids, org ids or payload data.
 *
 * OFF unless WORKER_METRICS_TOKEN (>= 32 chars) is set; then GET /metrics needs `Authorization: Bearer <token>`
 * (constant-time compare). Anything else is 404. Binds WORKER_METRICS_HOST (default 127.0.0.1) :WORKER_METRICS_PORT
 * (default 9464).
 *
 * The account-takeover follow-up queue and its DLQ (#463 review) are produced and consumed by apps/api under the
 * auth-mail key prefix, so they are read with AUTH_MAIL_QUEUE_PREFIX (same value as the API; default `bull`).
 */
export const MIN_WORKER_METRICS_TOKEN_LENGTH = 32;
export const JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'paused',
  'prioritized',
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const METRICS_QUEUES = [
  QUEUE_NAMES.transcription,
  QUEUE_NAMES.ai,
  QUEUE_NAMES.email,
  MEDIA_QUEUE,
  TRANSCRIPTION_DLQ,
  NOTIFICATION_DELIVERY_QUEUE,
  TASK_SYNC_QUEUE,
  EMBEDDINGS_QUEUE,
] as const;
/** Queues owned by apps/api and read under the auth-mail key prefix (AUTH_MAIL_QUEUE_PREFIX). */
export const AUTH_PREFIXED_METRICS_QUEUES = [
  AUTH_TAKEOVER_FOLLOW_UP_QUEUE,
  AUTH_TAKEOVER_FOLLOW_UP_DLQ,
] as const;
export const ALL_METRICS_QUEUES: readonly string[] = [
  ...METRICS_QUEUES,
  ...AUTH_PREFIXED_METRICS_QUEUES,
];

/** AUTH_MAIL_QUEUE_PREFIX as the API validates it; undefined = BullMQ default. Invalid values throw (name only). */
export function authQueuePrefixFromEnv(v: string | undefined): string | undefined {
  const p = (v ?? '').trim() || undefined;
  if (p !== undefined && !/^[A-Za-z0-9:_-]{1,64}$/.test(p))
    throw new Error('AUTH_MAIL_QUEUE_PREFIX has invalid characters');
  return p;
}

export type CountsReader = (queue: string) => Promise<Partial<Record<string, number>>>;

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export async function renderQueueMetrics(
  queues: readonly string[],
  read: CountsReader,
): Promise<string> {
  const results = await Promise.all(
    queues.map(async (q) => {
      try {
        return { q, counts: await read(q), error: 0 };
      } catch {
        return { q, counts: {}, error: 1 };
      }
    }),
  );
  const out = [
    '# HELP bullmq_queue_jobs BullMQ jobs by queue and state.',
    '# TYPE bullmq_queue_jobs gauge',
  ];
  for (const { q, counts, error } of results) {
    if (error) continue;
    for (const s of JOB_STATES) {
      const n = counts[s];
      out.push(`bullmq_queue_jobs{queue="${esc(q)}",state="${s}"} ${Number.isFinite(n) ? n : 0}`);
    }
  }
  out.push('# HELP bullmq_queue_scrape_error 1 when the queue counts could not be read.');
  out.push('# TYPE bullmq_queue_scrape_error gauge');
  for (const { q, error } of results)
    out.push(`bullmq_queue_scrape_error{queue="${esc(q)}"} ${error}`);
  return out.join('\n') + '\n';
}

export function workerMetricsTokenFromEnv(
  v: string | undefined,
  log?: MetricsLog,
): string | undefined {
  const t = v?.trim();
  if (t && t.length < MIN_WORKER_METRICS_TOKEN_LENGTH) {
    // Never log the token or its length beyond the threshold.
    log?.warn(
      { minLength: MIN_WORKER_METRICS_TOKEN_LENGTH },
      'WORKER_METRICS_TOKEN is shorter than the minimum; worker metrics endpoint stays off',
    );
    return undefined;
  }
  return t || undefined;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  return !!m && timingSafeEqual(digest(m[1]!), digest(token));
}

/** Request handler, split out for tests. Returns status, content type and body. */
export async function handleMetricsRequest(
  req: {
    method?: string | undefined;
    url?: string | undefined;
    authorization?: string | undefined;
  },
  opts: { token: string; queues: readonly string[]; read: CountsReader },
): Promise<{ status: number; type: string; body: string }> {
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'GET' || path !== '/metrics' || !bearerMatches(req.authorization, opts.token))
    return { status: 404, type: 'text/plain', body: 'Not Found\n' };
  return {
    status: 200,
    type: 'text/plain; version=0.0.4; charset=utf-8',
    body: await renderQueueMetrics(opts.queues, opts.read),
  };
}

/** Starts the exporter when WORKER_METRICS_TOKEN is set; otherwise returns undefined (endpoint off). */
export function startWorkerMetricsServer(
  env: NodeJS.ProcessEnv = process.env,
  read?: CountsReader,
  log: MetricsLog = logger,
): { server: Server; close: () => Promise<void> } | undefined {
  const token = workerMetricsTokenFromEnv(env.WORKER_METRICS_TOKEN, log);
  if (!token) return undefined;
  const port = Number.parseInt(env.WORKER_METRICS_PORT ?? '9464', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('WORKER_METRICS_PORT is invalid');
  const host = env.WORKER_METRICS_HOST?.trim() || '127.0.0.1';
  const authPrefix = authQueuePrefixFromEnv(env.AUTH_MAIL_QUEUE_PREFIX);
  const authQueues = new Set<string>(AUTH_PREFIXED_METRICS_QUEUES);
  if (!isLoopbackHost(host))
    log.warn(
      { host },
      'WORKER_METRICS_HOST is not loopback; expose the worker metrics endpoint on a private network only',
    );
  const owned = new Map<string, ReturnType<typeof createQueue>>();
  const reader: CountsReader =
    read ??
    ((q) => {
      let queue = owned.get(q);
      if (!queue)
        owned.set(
          q,
          (queue = createQueue(q, authQueues.has(q) && authPrefix ? { prefix: authPrefix } : {})),
        );
      return queue.getJobCounts(...JOB_STATES);
    });
  const server = createServer((req, res) => {
    void handleMetricsRequest(
      { method: req.method, url: req.url, authorization: req.headers.authorization },
      { token, queues: ALL_METRICS_QUEUES, read: reader },
    ).then(
      (r) =>
        res
          .writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store' })
          .end(r.body),
      () => res.writeHead(500).end(),
    );
  });
  // A bind failure (EADDRINUSE, EACCES, bad host) must not crash the worker: log and run without metrics.
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.warn(
      { code: err.code ?? 'unknown', port, host },
      'worker metrics endpoint failed to start; continuing without metrics',
    );
  });
  server.listen(port, host);
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
      await Promise.all([...owned.values()].map((q) => q.close()));
    },
  };
}
