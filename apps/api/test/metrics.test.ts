import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import {
  bearerMatches,
  DURATION_BUCKETS,
  HttpMetrics,
  metricsTokenFromEnv,
  MIN_METRICS_TOKEN_LENGTH,
} from '../src/shared/metrics.js';

const TOKEN = 'm'.repeat(MIN_METRICS_TOKEN_LENGTH);
const apps: Array<ReturnType<typeof createServer>> = [];
const server = (opts: Parameters<typeof createServer>[0] = {}) => {
  const app = createServer({ nodeEnv: 'test', databaseUrl: '', redisUrl: '', ...opts });
  apps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
const scrape = (app: ReturnType<typeof createServer>, auth = `Bearer ${TOKEN}`) =>
  app.inject({ method: 'GET', url: '/metrics', headers: { authorization: auth } });

describe('GET /metrics', () => {
  it('is not served (404) when METRICS_TOKEN is unset or too short', async () => {
    expect((await scrape(server({ metricsToken: '' }))).statusCode).toBe(404);
    expect((await scrape(server({ metricsToken: 'short' }), 'Bearer short')).statusCode).toBe(404);
  });

  it('404 without or with a wrong bearer token; never echoes the token', async () => {
    const app = server({ metricsToken: TOKEN });
    for (const auth of ['', 'Bearer nope', `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
      const res = await scrape(app, auth);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(TOKEN);
    }
  });

  it('serves Prometheus text with route templates, not raw URLs', async () => {
    const app = server({ metricsToken: TOKEN });
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health?secret=abc' });
    await app.inject({ method: 'GET', url: '/nope/123e4567-e89b-12d3-a456-426614174000' });
    const res = await scrape(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    const body = res.body;
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(body).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 1');
    expect(body).toContain('http_request_duration_seconds_count{method="GET",route="/health"} 2');
    expect(body).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 2',
    );
    expect(body).toMatch(/^process_resident_memory_bytes \d+$/m);
    expect(body).not.toContain('secret=abc');
    expect(body).not.toContain('123e4567');
    // The scrape itself is not counted.
    expect(body).not.toContain('route="/metrics"');
  });

  it('is hidden from the OpenAPI spec', async () => {
    const app = server({ metricsToken: TOKEN });
    await app.ready();
    expect(JSON.stringify(app.swagger())).not.toContain('/metrics');
  });
});

describe('HttpMetrics', () => {
  it('cumulative buckets, sum, count; unknown methods collapse to OTHER; labels escaped', () => {
    const m = new HttpMetrics(
      () => 1,
      () => ({ rss: 10, heapUsed: 5 }),
    );
    m.observe('GET', '/a', 200, 0.003);
    m.observe('GET', '/a', 200, 0.2);
    m.observe('BREW', '/a"\\\n', 418, 20);
    const t = m.render();
    expect(t).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/a",le="0.005"} 1',
    );
    expect(t).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/a",le="0.25"} 2',
    );
    expect(t).toContain(
      `http_request_duration_seconds_bucket{method="GET",route="/a",le="${DURATION_BUCKETS.at(-1)}"} 2`,
    );
    expect(t).toContain('http_request_duration_seconds_sum{method="GET",route="/a"} 0.203');
    expect(t).toContain('http_requests_total{method="OTHER",route="/a\\"\\\\\\n",status="418"} 1');
    expect(t).toContain(
      'http_request_duration_seconds_bucket{method="OTHER",route="/a\\"\\\\\\n",le="10"} 0',
    );
    expect(t).toContain('process_uptime_seconds 1\n');
    expect(t).toContain('nodejs_heap_used_bytes 5\n');
    expect(t.endsWith('\n')).toBe(true);
  });
});

describe('metrics token helpers', () => {
  it('metricsTokenFromEnv requires the minimum length', () => {
    expect(metricsTokenFromEnv(undefined)).toBeUndefined();
    expect(metricsTokenFromEnv('  ')).toBeUndefined();
    expect(metricsTokenFromEnv('x'.repeat(MIN_METRICS_TOKEN_LENGTH - 1))).toBeUndefined();
    expect(metricsTokenFromEnv(` ${TOKEN} `)).toBe(TOKEN);
  });
  it('bearerMatches is exact', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
  });
});
