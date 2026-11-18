import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALL_METRICS_QUEUES,
  AUTH_PREFIXED_METRICS_QUEUES,
  authQueuePrefixFromEnv,
  handleMetricsRequest,
  METRICS_QUEUES,
  MIN_WORKER_METRICS_TOKEN_LENGTH,
  renderQueueMetrics,
  startWorkerMetricsServer,
  workerMetricsTokenFromEnv,
  isLoopbackHost,
} from '../src/metrics.js';
import { createServer as createNetServer } from 'node:net';

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
      expect.arrayContaining([
        'transcription',
        'transcription-dlq',
        'media',
        'ai',
        'ai-provider-transcript-delete',
      ]),
    );
  });

  it('covers the API-owned takeover follow-up queue and DLQ, read under AUTH_MAIL_QUEUE_PREFIX', async () => {
    expect(AUTH_PREFIXED_METRICS_QUEUES).toEqual([
      'auth-takeover-follow-up',
      'auth-takeover-follow-up-dlq',
    ]);
    expect(ALL_METRICS_QUEUES).toEqual(
      expect.arrayContaining([...METRICS_QUEUES, ...AUTH_PREFIXED_METRICS_QUEUES]),
    );
    expect(authQueuePrefixFromEnv(undefined)).toBeUndefined();
    expect(authQueuePrefixFromEnv('  ')).toBeUndefined();
    expect(authQueuePrefixFromEnv('qa:it:x')).toBe('qa:it:x');
    expect(() => authQueuePrefixFromEnv('bad prefix')).toThrow(/AUTH_MAIL_QUEUE_PREFIX/);
    expect(() =>
      startWorkerMetricsServer(
        { WORKER_METRICS_TOKEN: TOKEN, AUTH_MAIL_QUEUE_PREFIX: '{x}' },
        read,
      ),
    ).toThrow(/AUTH_MAIL_QUEUE_PREFIX/);
    const s = startWorkerMetricsServer(
      { WORKER_METRICS_TOKEN: TOKEN, WORKER_METRICS_PORT: '0' },
      read,
    );
    closers.push(s!.close);
    await new Promise((r) => s!.server.once('listening', r));
    const { port } = s!.server.address() as { port: number };
    const body = await (
      await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).text();
    expect(body).toContain(
      'bullmq_queue_jobs{queue="auth-takeover-follow-up-dlq",state="failed"} 2',
    );
    expect(body).toContain('bullmq_queue_scrape_error{queue="auth-takeover-follow-up"} 0');
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
        'MeetOpsTakeoverFollowUpDlqNotEmpty',
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

describe('worker metrics exporter hardening', () => {
  const mkLog = () => {
    const warns: Array<{ obj: object; msg: string }> = [];
    return { warns, log: { warn: (obj: object, msg: string) => warns.push({ obj, msg }) } };
  };

  it('warns (without the token) when WORKER_METRICS_TOKEN is too short, and stays off', () => {
    const { warns, log } = mkLog();
    expect(
      startWorkerMetricsServer({ WORKER_METRICS_TOKEN: 'short-secret' }, read, log),
    ).toBeUndefined();
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toMatch(/shorter than the minimum/);
    expect(JSON.stringify(warns)).not.toContain('short-secret');
  });

  it('does not warn when the token is unset', () => {
    const { warns, log } = mkLog();
    expect(workerMetricsTokenFromEnv(undefined, log)).toBeUndefined();
    expect(warns).toHaveLength(0);
  });

  it('classifies loopback hosts and warns for a non-loopback bind', async () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    const { warns, log } = mkLog();
    const s = startWorkerMetricsServer(
      { WORKER_METRICS_TOKEN: TOKEN, WORKER_METRICS_PORT: '0', WORKER_METRICS_HOST: '0.0.0.0' },
      read,
      log,
    );
    await new Promise((r) => s!.server.once('listening', r));
    await s!.close();
    expect(warns.some((w) => /not loopback/.test(w.msg))).toBe(true);
  });

  it('EADDRINUSE is logged and does not throw; close() still resolves', async () => {
    const blocker = createNetServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;
    const { warns, log } = mkLog();
    const s = startWorkerMetricsServer(
      { WORKER_METRICS_TOKEN: TOKEN, WORKER_METRICS_PORT: String(port) },
      read,
      log,
    );
    await new Promise((r) => s!.server.once('error', r));
    await new Promise((r) => setImmediate(r));
    expect(warns.some((w) => (w.obj as { code?: string }).code === 'EADDRINUSE')).toBe(true);
    expect(s!.server.listening).toBe(false);
    await s!.close();
    await new Promise<void>((r) => blocker.close(() => r()));
  });
});
