import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleMetricsRequest,
  METRICS_QUEUES,
  MIN_WORKER_METRICS_TOKEN_LENGTH,
  renderQueueMetrics,
  startWorkerMetricsServer,
  workerMetricsTokenFromEnv,
} from '../src/metrics.js';

const TOKEN = 'w'.repeat(MIN_WORKER_METRICS_TOKEN_LENGTH);
const read = async (q: string) => {
  if (q === 'broken') throw new Error('redis down');
  return { waiting: 3, active: 1, failed: 2 };
};

describe('worker queue metrics', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  it('renders bullmq_queue_jobs per state (missing states as 0) and a scrape error flag', async () => {
    const text = await renderQueueMetrics(['transcription', 'broken'], read);
    expect(text).toContain('bullmq_queue_jobs{queue="transcription",state="waiting"} 3');
    expect(text).toContain('bullmq_queue_jobs{queue="transcription",state="delayed"} 0');
    expect(text).toContain('bullmq_queue_scrape_error{queue="transcription"} 0');
    expect(text).toContain('bullmq_queue_scrape_error{queue="broken"} 1');
    expect(text).not.toContain('queue="broken",state');
    expect(text).not.toContain('redis down');
  });

  it('covers the transcription DLQ and the main queues', () => {
    expect(METRICS_QUEUES).toEqual(
      expect.arrayContaining(['transcription', 'transcription-dlq', 'media', 'ai']),
    );
  });

  it('is off without a >= 32 char token', () => {
    expect(workerMetricsTokenFromEnv(undefined)).toBeUndefined();
    expect(workerMetricsTokenFromEnv('short')).toBeUndefined();
    expect(startWorkerMetricsServer({}, read)).toBeUndefined();
  });

  it('404s on a wrong/missing token, other paths and methods; 200 with the token', async () => {
    const opts = { token: TOKEN, queues: ['media'], read };
    for (const req of [
      { method: 'GET', url: '/metrics' },
      { method: 'GET', url: '/metrics', authorization: 'Bearer nope' },
      { method: 'POST', url: '/metrics', authorization: `Bearer ${TOKEN}` },
      { method: 'GET', url: '/other', authorization: `Bearer ${TOKEN}` },
    ])
      expect((await handleMetricsRequest(req, opts)).status).toBe(404);
    const ok = await handleMetricsRequest(
      { method: 'GET', url: '/metrics?x=1', authorization: `Bearer ${TOKEN}` },
      opts,
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('bullmq_queue_jobs{queue="media",state="active"} 1');
    expect(ok.body).not.toContain(TOKEN);
  });

  it('serves over HTTP on loopback when enabled and rejects a bad port', async () => {
    expect(() =>
      startWorkerMetricsServer({ WORKER_METRICS_TOKEN: TOKEN, WORKER_METRICS_PORT: '70000' }, read),
    ).toThrow(/WORKER_METRICS_PORT/);
    const s = startWorkerMetricsServer(
      { WORKER_METRICS_TOKEN: TOKEN, WORKER_METRICS_PORT: '0' },
      read,
    );
    expect(s).toBeDefined();
    closers.push(s!.close);
    await new Promise((r) => s!.server.once('listening', r));
    const addr = s!.server.address() as { port: number; address: string };
    expect(addr.address).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('bullmq_queue_scrape_error{queue="transcription"} 0');
  });
});

describe('worker Prometheus alert rules', () => {
  const text = readFileSync(
    new URL('../../../infra/monitoring/prometheus/worker-alerts.rules.yml', import.meta.url),
    'utf8',
  );
  const doc = readFileSync(
    new URL('../../../docs/14-observability/alerts.md', import.meta.url),
    'utf8',
  );
  const alerts = [...text.matchAll(/- alert: (\S+)/g)].map((m) => m[1]!);
  const exprs = [...text.matchAll(/expr: (.*)/g)].map((m) => m[1]!);

  it('has a queue-depth, failed-jobs, DLQ and scrape-error alert, each documented and job-scoped', () => {
    expect(alerts).toEqual(
      expect.arrayContaining([
        'MeetOpsQueueBacklog',
        'MeetOpsQueueFailedJobsRising',
        'MeetOpsTranscriptionDlqNotEmpty',
        'MeetOpsQueueScrapeError',
      ]),
    );
    expect(exprs).toHaveLength(alerts.length);
    for (const a of alerts) {
      expect(doc).toContain(`## ${a}`);
      expect(text).toContain(`runbook: docs/14-observability/alerts.md#${a.toLowerCase()}`);
    }
    for (const e of exprs) expect(e).toContain('job="meetops-worker"');
  });

  it('only references metrics the exporter emits (plus up)', async () => {
    const body = await renderQueueMetrics(['transcription'], read);
    const emitted = new Set(['up', ...[...body.matchAll(/^([a-z_]+)\{/gm)].map((m) => m[1]!)]);
    for (const e of exprs)
      for (const name of e.match(/\b(bullmq_[a-z_]+|up)\b/g) ?? []) expect(emitted).toContain(name);
  });
});
