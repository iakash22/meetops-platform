import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

/**
 * Minimal Prometheus text exposition (format 0.0.4) for the API, with no client library (Phase 9 monitoring).
 *
 * - `http_requests_total{method,route,status}` and `http_request_duration_seconds{method,route}` (histogram).
 *   `route` is the matched route TEMPLATE (e.g. `/orgs/:orgId/meetings`), never the raw URL, so ids, tokens in
 *   paths and query strings never become labels. Unmatched requests use `route="unmatched"`.
 * - Process gauges: uptime, resident memory, heap used.
 * - `/metrics` is OFF unless METRICS_TOKEN (>= 32 chars) is set, and then requires `Authorization: Bearer <token>`
 *   (constant-time compare). Disabled or wrong token: 404, so the endpoint is not advertised.
 */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export const MIN_METRICS_TOKEN_LENGTH = 32;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

type Hist = { buckets: number[]; sum: number; count: number };

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string>) =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(',')}}`;

export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Hist>();
  constructor(
    private readonly now: () => number = () => process.uptime(),
    private readonly memory: () => { rss: number; heapUsed: number } = () => process.memoryUsage(),
  ) {}

  observe(method: string, route: string, status: number, seconds: number): void {
    const m = METHODS.has(method) ? method : 'OTHER';
    const rk = JSON.stringify([m, route, String(status)]);
    this.requests.set(rk, (this.requests.get(rk) ?? 0) + 1);
    const dk = JSON.stringify([m, route]);
    let h = this.durations.get(dk);
    if (!h)
      this.durations.set(dk, (h = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }));
    DURATION_BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
  }

  render(): string {
    const out: string[] = [];
    out.push('# HELP http_requests_total HTTP requests by method, route template and status code.');
    out.push('# TYPE http_requests_total counter');
    for (const [k, v] of [...this.requests].sort()) {
      const [method, route, status] = JSON.parse(k) as [string, string, string];
      out.push(`http_requests_total${labels({ method, route, status })} ${v}`);
    }
    out.push(
      '# HELP http_request_duration_seconds HTTP request duration by method and route template.',
    );
    out.push('# TYPE http_request_duration_seconds histogram');
    for (const [k, h] of [...this.durations].sort()) {
      const [method, route] = JSON.parse(k) as [string, string];
      DURATION_BUCKETS.forEach((b, i) =>
        out.push(
          `http_request_duration_seconds_bucket${labels({ method, route, le: String(b) })} ${h.buckets[i]}`,
        ),
      );
      out.push(
        `http_request_duration_seconds_bucket${labels({ method, route, le: '+Inf' })} ${h.count}`,
      );
      out.push(`http_request_duration_seconds_sum${labels({ method, route })} ${h.sum}`);
      out.push(`http_request_duration_seconds_count${labels({ method, route })} ${h.count}`);
    }
    const mem = this.memory();
    out.push('# HELP process_uptime_seconds Seconds since the process started.');
    out.push('# TYPE process_uptime_seconds gauge');
    out.push(`process_uptime_seconds ${this.now()}`);
    out.push('# HELP process_resident_memory_bytes Resident set size in bytes.');
    out.push('# TYPE process_resident_memory_bytes gauge');
    out.push(`process_resident_memory_bytes ${mem.rss}`);
    out.push('# HELP nodejs_heap_used_bytes V8 heap used in bytes.');
    out.push('# TYPE nodejs_heap_used_bytes gauge');
    out.push(`nodejs_heap_used_bytes ${mem.heapUsed}`);
    return out.join('\n') + '\n';
  }
}

/** Token from METRICS_TOKEN; shorter than MIN_METRICS_TOKEN_LENGTH counts as unset (endpoint off). */
export function metricsTokenFromEnv(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && t.length >= MIN_METRICS_TOKEN_LENGTH ? t : undefined;
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  // Hash both sides so the compare is constant-time regardless of length.
  return !!m && timingSafeEqual(digest(m[1]!), digest(token));
}

export function registerMetrics(
  app: FastifyInstance,
  opts: { token: string | undefined; metrics?: HttpMetrics },
): HttpMetrics {
  const metrics = opts.metrics ?? new HttpMetrics();
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === '/metrics') return;
    metrics.observe(req.method, route ?? 'unmatched', reply.statusCode, reply.elapsedTime / 1000);
  });
  if (opts.token) {
    const token = opts.token;
    app.get('/metrics', { logLevel: 'warn', schema: { hide: true } }, async (req, reply) => {
      if (!bearerMatches(req.headers.authorization, token)) return reply.callNotFound();
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render());
    });
  }
  return metrics;
}
