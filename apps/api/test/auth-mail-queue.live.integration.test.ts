/**
 * Live auth mail queue: real Redis (BullMQ, keys under `qa:it:`) + Mailpit SMTP. Skips unless TEST_REDIS_URL,
 * TEST_MAILPIT_SMTP_PORT and TEST_MAILPIT_URL (Mailpit HTTP API) are set and reachable. Per-run addresses, and the
 * queue is obliterated afterwards.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, type Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createAuthMailTransport,
  createEmailService,
  loadEmailConfig,
} from '@meetops/notifications';
import { createServer } from '../src/server.js';
import { defaultModuleDeps } from '../src/modules/index.js';
import { AuthMailJobHandler } from '../src/modules/auth/application/auth-mail.handler.js';
import {
  AUTH_MAIL_QUEUE,
  authMailJobId,
  BullMqAuthMailQueue,
  createAuthMailProducer,
  startAuthMailWorker,
} from '../src/modules/auth/infrastructure/mail-queue/bullmq-mail-queue.js';
import { Client, fakeHasher, PASSWORD } from './helpers.js';

const redisUrl = process.env.TEST_REDIS_URL;
const smtpPort = process.env.TEST_MAILPIT_SMTP_PORT;
const mailpitUrl = process.env.TEST_MAILPIT_URL;
const PREFIX = 'qa:it';

async function reachable(): Promise<boolean> {
  if (!redisUrl || !smtpPort || !mailpitUrl) return false;
  const r = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1500,
  });
  try {
    await r.connect();
    await r.ping();
    const res = await fetch(new URL('/api/v1/info', mailpitUrl), {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch (e) {
    console.warn('auth mail live test skipped:', (e as Error).name);
    return false;
  } finally {
    r.disconnect();
  }
}

const live = await reachable();

async function messagesTo(to: string): Promise<{ Subject: string }[]> {
  const u = new URL('/api/v1/search', mailpitUrl);
  u.searchParams.set('query', `to:"${to}"`);
  const res = await fetch(u);
  const body = (await res.json()) as { messages?: { Subject: string }[] };
  return body.messages ?? [];
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!live)('auth mail queue (live Redis + Mailpit)', () => {
  const run = randomUUID().slice(0, 8);
  const email = `qa-it-${run}@example.test`;
  let worker: Worker | undefined;
  let queue: BullMqAuthMailQueue;
  let inspect: Queue;
  let app: ReturnType<typeof createServer>;

  beforeAll(async () => {
    const config = loadEmailConfig({
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: smtpPort,
      SMTP_SECURE: 'false',
      EMAIL_FROM: 'MeetOps QA <qa@example.test>',
    });
    const transport = createAuthMailTransport(createEmailService(config, { nodeEnv: 'test' }));
    queue = new BullMqAuthMailQueue(
      createAuthMailProducer({ redisUrl: redisUrl!, prefix: PREFIX }),
      {
        now: () => new Date(),
      },
    );
    inspect = new Queue(AUTH_MAIL_QUEUE, {
      connection: { url: redisUrl!, maxRetriesPerRequest: null },
      prefix: PREFIX,
    });
    const deps = defaultModuleDeps(
      { hasher: fakeHasher, mailTransport: transport, mailQueue: queue },
      { nodeEnv: 'test' },
    );
    worker = startAuthMailWorker(new AuthMailJobHandler({ ...deps, transport }), {
      redisUrl: redisUrl!,
      prefix: PREFIX,
      concurrency: 2,
    });
    app = createServer({ deps });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await queue?.close();
    await inspect?.obliterate({ force: true }).catch(() => {});
    await inspect?.close();
  });

  it('signup enqueues an ids-only job and the worker delivers it over SMTP to Mailpit', async () => {
    const c = new Client(app as never);
    const r = await c.post('/auth/signup', { name: 'QA', email, password: PASSWORD });
    expect(r.statusCode).toBe(202);
    const msgs = await waitFor(async () => {
      const m = await messagesTo(email);
      return m.length ? m : undefined;
    });
    expect(msgs).toHaveLength(1);
    const jobs = await inspect.getJobs(['completed', 'waiting', 'active', 'delayed', 'failed']);
    const mine = jobs.filter((j) => j.name === 'email_verification');
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const j of mine) {
      expect(j.id).toMatch(/^authmail_email_verification_[0-9a-f]{40}$/);
      expect(JSON.stringify(j.data)).not.toContain('@');
    }
    const r2 = new Redis(redisUrl!);
    const keys = await r2.keys(`${PREFIX}:${AUTH_MAIL_QUEUE}:*`);
    r2.disconnect();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith('qa:it:'))).toBe(true);
  });

  it('the same job enqueued twice is delivered once', async () => {
    const job = { kind: 'account_exists' as const, userId: `missing-${run}` };
    await queue.enqueue(job);
    await queue.enqueue(job);
    const id = authMailJobId(job, new Date())!;
    const j = await waitFor(async () => {
      const x = await inspect.getJob(id);
      return x && (await x.isCompleted()) ? x : undefined;
    });
    expect(j.id).toBe(id);
    const all = await inspect.getJobs(['completed', 'waiting', 'active', 'delayed']);
    expect(all.filter((x) => x.name === 'account_exists')).toHaveLength(1);
  });
});
