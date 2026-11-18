import { afterEach, describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  PROVIDER_TRANSCRIPT_DELETE_ATTEMPTS,
  PROVIDER_TRANSCRIPT_DELETE_BACKOFF_MS,
  PROVIDER_TRANSCRIPT_DELETE_JOB_NAME,
  PROVIDER_TRANSCRIPT_DELETE_QUEUE,
  createProviderTranscriptDeleteProcessor,
  createQueueProviderTranscriptDeleteTrigger,
  createRepositoryProviderJobIdLookup,
  enqueueProviderTranscriptDelete,
  isProviderTranscriptDeleteEnabled,
  processProviderTranscriptDelete,
  registerProviderTranscriptDeleteWorker,
  providerTranscriptDeleteJobId,
  renderProviderTranscriptDeleteMetrics,
  resetProviderTranscriptDeleteFailureCounts,
  type ProviderTranscriptDeleteQueueLike,
  type ProviderTranscriptDeleter,
} from '../src/ai/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const SECRET = 'CONFIDENTIAL_MEETING_WORDS never-log-this';

afterEach(() => {
  resetProviderTranscriptDeleteFailureCounts();
});

const logger = () => {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  return {
    entries,
    blob: () => JSON.stringify(entries),
    logger: {
      info(obj: object, msg: string) {
        entries.push({ level: 'info', obj: obj as Record<string, unknown>, msg });
      },
      warn(obj: object, msg: string) {
        entries.push({ level: 'warn', obj: obj as Record<string, unknown>, msg });
      },
      error(obj: object, msg: string) {
        entries.push({ level: 'error', obj: obj as Record<string, unknown>, msg });
      },
    },
  };
};

describe('provider transcript delete enqueue', () => {
  it('uses a deterministic jobId, retries, and is idempotent per provider transcript id', async () => {
    const adds: Array<{ name: string; data: unknown; opts: { jobId: string; attempts: number } }> =
      [];
    const ids = new Set<string>();
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (name, data, opts) => {
        if (ids.has(opts.jobId)) {
          throw new Error('Job is already waiting');
        }
        ids.add(opts.jobId);
        adds.push({ name, data, opts });
      },
    };
    const payload = {
      organizationId: ORG,
      provider: 'assemblyai' as const,
      providerTranscriptId: 'tr-abc',
      meetingId: MEET,
      recordingId: REC,
    };
    expect(await enqueueProviderTranscriptDelete(queue, payload)).toEqual({ enqueued: true });
    expect(await enqueueProviderTranscriptDelete(queue, payload)).toEqual({
      enqueued: false,
      reason: 'duplicate',
    });
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({
      name: PROVIDER_TRANSCRIPT_DELETE_JOB_NAME,
      data: payload,
      opts: {
        jobId: providerTranscriptDeleteJobId('assemblyai', 'tr-abc'),
        attempts: PROVIDER_TRANSCRIPT_DELETE_ATTEMPTS,
        backoff: { type: 'exponential', delay: PROVIDER_TRANSCRIPT_DELETE_BACKOFF_MS },
      },
    });
    expect(adds[0]?.opts.jobId).toBe('provider-transcript-delete__assemblyai__tr-abc');
    expect(adds[0]?.opts.jobId).not.toContain(':');
  });

  it('skips and logs without content when the provider job id is missing (legacy rows)', async () => {
    const adds: unknown[] = [];
    const log = logger();
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (name, data, opts) => {
        adds.push({ name, data, opts });
      },
    };
    const trigger = createQueueProviderTranscriptDeleteTrigger(queue, {
      enabled: true,
      logger: log.logger,
    });
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 0,
      provider: 'assemblyai',
    });
    expect(adds).toEqual([]);
    expect(log.entries.some((e) => e.msg.includes('no provider job id'))).toBe(true);
    expect(log.blob()).not.toContain(SECRET);
    expect(log.entries.every((e) => e.obj.providerTranscriptId === undefined)).toBe(true);
  });

  it('does not enqueue when the feature flag is off (default is on)', async () => {
    expect(isProviderTranscriptDeleteEnabled({})).toBe(true);
    expect(
      isProviderTranscriptDeleteEnabled({ AI_PROVIDER_TRANSCRIPT_DELETE_ENABLED: 'false' }),
    ).toBe(false);
    const adds: unknown[] = [];
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (name, data, opts) => {
        adds.push({ name, data, opts });
      },
    };
    const payload = {
      organizationId: ORG,
      provider: 'assemblyai' as const,
      providerTranscriptId: 'tr-off',
    };
    expect(await enqueueProviderTranscriptDelete(queue, payload, { enabled: false })).toEqual({
      enqueued: false,
      reason: 'disabled',
    });
    expect(adds).toEqual([]);
  });

  it('enqueues only for AssemblyAI after a stored provider job id', async () => {
    const adds: Array<{ data: { providerTranscriptId: string } }> = [];
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (_name, data) => {
        adds.push({ data });
      },
    };
    const trigger = createQueueProviderTranscriptDeleteTrigger(queue, { enabled: true });
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 0,
      provider: 'gemini',
      providerJobId: 'not-a-transcript',
    });
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 0,
      provider: 'assemblyai',
      providerJobId: 'tr-hook',
    });
    expect(adds).toEqual([{ data: expect.objectContaining({ providerTranscriptId: 'tr-hook' }) }]);
  });

  it('enqueues one deterministic job per chunk id and treats a retry of the same id as a duplicate', async () => {
    const adds: Array<{ data: { providerTranscriptId: string }; opts: { jobId: string } }> = [];
    const ids = new Set<string>();
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (_name, data, opts) => {
        if (ids.has(opts.jobId)) throw new Error('Job is already waiting');
        ids.add(opts.jobId);
        adds.push({ data, opts });
      },
    };
    const trigger = createQueueProviderTranscriptDeleteTrigger(queue, { enabled: true });
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 0,
      provider: 'assemblyai',
      providerJobId: 'tr-chunk-0',
    });
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 1,
      provider: 'assemblyai',
      providerJobId: 'tr-chunk-1',
    });
    // Same id again (retry / anchor also holding chunk 1) must not enqueue a second job.
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 1,
      provider: 'assemblyai',
      providerJobId: 'tr-chunk-1',
    });
    expect(adds.map((a) => a.data.providerTranscriptId)).toEqual(['tr-chunk-0', 'tr-chunk-1']);
    expect(adds.map((a) => a.opts.jobId)).toEqual([
      providerTranscriptDeleteJobId('assemblyai', 'tr-chunk-0'),
      providerTranscriptDeleteJobId('assemblyai', 'tr-chunk-1'),
    ]);
  });

  it('enqueues every id from stored segments plus a first-write-loser payload id, without duplicates', async () => {
    const adds: string[] = [];
    const seen = new Set<string>();
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (_name, data, opts) => {
        if (seen.has(opts.jobId)) throw new Error('Job is already waiting');
        seen.add(opts.jobId);
        adds.push(data.providerTranscriptId);
      },
    };
    const trigger = createQueueProviderTranscriptDeleteTrigger(queue, {
      enabled: true,
      listProviderJobIds: async () => ['tr-chunk-0', 'tr-chunk-1'],
    });
    await trigger({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 1,
      provider: 'assemblyai',
      providerJobId: 'tr-loser',
    });
    expect(adds).toEqual(['tr-loser', 'tr-chunk-0', 'tr-chunk-1']);
  });

  it('does not enqueue an invalid transcript id format', async () => {
    const adds: unknown[] = [];
    const queue: ProviderTranscriptDeleteQueueLike = {
      add: async (_name, data, opts) => {
        adds.push({ data, opts });
      },
    };
    expect(
      await enqueueProviderTranscriptDelete(queue, {
        organizationId: ORG,
        provider: 'assemblyai',
        providerTranscriptId: 'not a valid id!!!',
        meetingId: MEET,
        recordingId: REC,
      }),
    ).toEqual({ enqueued: false, reason: 'invalid_id' });
    expect(adds).toEqual([]);
  });
});

describe('processProviderTranscriptDelete', () => {
  const job = {
    organizationId: ORG,
    provider: 'assemblyai' as const,
    providerTranscriptId: 'tr-1',
    meetingId: MEET,
    recordingId: REC,
  };
  const fromDb =
    (id: string | undefined = 'tr-1') =>
    async () =>
      id;

  it('treats a successful delete and a 404 as success without logging content', async () => {
    const log = logger();
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript(id) {
        expect(id).toBe('tr-1');
        return { outcome: 'deleted', httpStatus: 200 };
      },
    };
    await expect(
      processProviderTranscriptDelete(
        job,
        { resolveDeleter: async () => deleter, resolveProviderJobId: fromDb(), logger: log.logger },
        {
          isFinalAttempt: false,
          jobId: 'j1',
        },
      ),
    ).resolves.toEqual({ outcome: 'deleted', httpStatus: 200 });

    const gone: ProviderTranscriptDeleter = {
      async deleteTranscript() {
        return { outcome: 'already_deleted', httpStatus: 404 };
      },
    };
    await expect(
      processProviderTranscriptDelete(
        job,
        { resolveDeleter: async () => gone, resolveProviderJobId: fromDb(), logger: log.logger },
        {
          isFinalAttempt: false,
        },
      ),
    ).resolves.toEqual({ outcome: 'already_deleted', httpStatus: 404 });

    expect(log.blob()).not.toContain(SECRET);
    expect(log.entries.map((e) => e.obj.httpStatus)).toEqual([200, 404]);
    expect(log.entries.some((e) => JSON.stringify(e).includes('text'))).toBe(false);
  });

  it('skips cleanly when the job and the stored row have no provider job id (legacy), without calling delete', async () => {
    const log = logger();
    let called = 0;
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript() {
        called += 1;
        return { outcome: 'deleted', httpStatus: 200 };
      },
    };
    await expect(
      processProviderTranscriptDelete(
        { ...job, providerTranscriptId: '' },
        {
          resolveDeleter: async () => deleter,
          resolveProviderJobId: async () => undefined,
          logger: log.logger,
        },
        { isFinalAttempt: false, jobId: 'j-legacy' },
      ),
    ).resolves.toEqual({ outcome: 'already_deleted', httpStatus: 0 });
    expect(called).toBe(0);
    expect(log.entries.some((e) => e.msg.includes('no provider job id'))).toBe(true);
    expect(log.blob()).not.toContain(SECRET);
    expect(log.entries.every((e) => e.obj.providerTranscriptId === undefined)).toBe(true);
  });

  it('deletes every given chunk id, not a later anchor overwrite, and 404 retries stay idempotent', async () => {
    const log = logger();
    const deleted: string[] = [];
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript(id) {
        deleted.push(id);
        return deleted.filter((x) => x === id).length === 1
          ? { outcome: 'deleted', httpStatus: 200 }
          : { outcome: 'already_deleted', httpStatus: 404 };
      },
    };
    const deps = {
      resolveDeleter: async () => deleter,
      // Simulate #513's anchor holding only the last chunk id.
      resolveProviderJobId: fromDb('tr-chunk-1'),
      logger: log.logger,
    };
    await expect(
      processProviderTranscriptDelete({ ...job, providerTranscriptId: 'tr-chunk-0' }, deps, {
        isFinalAttempt: false,
        jobId: 'j-c0',
      }),
    ).resolves.toEqual({ outcome: 'deleted', httpStatus: 200 });
    await expect(
      processProviderTranscriptDelete({ ...job, providerTranscriptId: 'tr-chunk-1' }, deps, {
        isFinalAttempt: false,
        jobId: 'j-c1',
      }),
    ).resolves.toEqual({ outcome: 'deleted', httpStatus: 200 });
    await expect(
      processProviderTranscriptDelete({ ...job, providerTranscriptId: 'tr-chunk-0' }, deps, {
        isFinalAttempt: false,
        jobId: 'j-c0-retry',
      }),
    ).resolves.toEqual({ outcome: 'already_deleted', httpStatus: 404 });
    expect(deleted).toEqual(['tr-chunk-0', 'tr-chunk-1', 'tr-chunk-0']);
    expect(log.blob()).not.toContain(SECRET);
  });

  it('createRepositoryProviderJobIdLookup prefers a given id when it is stored, else the first stored id', async () => {
    const lookup = createRepositoryProviderJobIdLookup({
      withOrgContext: async (_org, fn) =>
        fn({
          getProviderJobId: async () => 'tr-anchor',
          listProviderJobIds: async () => ['tr-a', 'tr-b'],
        }),
    });
    expect(
      await lookup({
        organizationId: ORG,
        meetingId: MEET,
        recordingId: REC,
        providerTranscriptId: 'tr-b',
      }),
    ).toBe('tr-b');
    expect(
      await lookup({
        organizationId: ORG,
        meetingId: MEET,
        recordingId: REC,
        providerTranscriptId: 'tr-unknown',
      }),
    ).toBeUndefined();
    expect(await lookup({ organizationId: ORG, meetingId: MEET, recordingId: REC })).toBe('tr-a');
  });

  it('retries on 5xx and emits a metric hook on final failure without content', async () => {
    const log = logger();
    const failures: Array<Record<string, unknown>> = [];
    const err = Object.assign(new Error(`assemblyai HTTP 503`), { status: 503 });
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript() {
        throw err;
      },
    };
    await expect(
      processProviderTranscriptDelete(
        job,
        {
          resolveDeleter: async () => deleter,
          resolveProviderJobId: fromDb(),
          logger: log.logger,
          onFinalFailure: (i) => failures.push(i),
        },
        { isFinalAttempt: false, jobId: 'j-retry' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(failures).toEqual([]);

    await expect(
      processProviderTranscriptDelete(
        job,
        {
          resolveDeleter: async () => deleter,
          resolveProviderJobId: fromDb(),
          logger: log.logger,
          onFinalFailure: (i) => failures.push(i),
        },
        { isFinalAttempt: true, jobId: 'j-final' },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(failures).toEqual([
      expect.objectContaining({
        provider: 'assemblyai',
        providerTranscriptId: 'tr-1',
        organizationId: ORG,
        httpStatus: 503,
        errorCode: 'PROVIDER_UNAVAILABLE',
      }),
    ]);
    expect(log.blob()).not.toContain(SECRET);
    expect(renderProviderTranscriptDeleteMetrics()).toContain(
      'meetops_provider_transcript_delete_failures_total{provider="assemblyai"} 1',
    );
  });

  it('does not retry a non-retryable error and never logs transcript text', async () => {
    const log = logger();
    const err = Object.assign(new Error(`assemblyai HTTP 401`), { status: 401 });
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript() {
        throw err;
      },
    };
    await expect(
      processProviderTranscriptDelete(
        job,
        { resolveDeleter: async () => deleter, resolveProviderJobId: fromDb(), logger: log.logger },
        { isFinalAttempt: false },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(log.blob()).not.toContain(SECRET);
    expect(log.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('rejects an invalid transcript id format without calling the provider or logging content', async () => {
    const log = logger();
    let called = 0;
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript() {
        called += 1;
        return { outcome: 'deleted', httpStatus: 200 };
      },
    };
    await expect(
      processProviderTranscriptDelete(
        { ...job, providerTranscriptId: 'https://evil.example/tr' },
        {
          resolveDeleter: async () => deleter,
          resolveProviderJobId: async () => undefined,
          logger: log.logger,
        },
        { isFinalAttempt: false, jobId: 'j-bad' },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(called).toBe(0);
    expect(log.blob()).not.toContain(SECRET);
    expect(log.entries.every((e) => e.obj.providerTranscriptId === undefined)).toBe(true);
  });

  it('retries transport errors that have no HTTP status without changing global mapping', async () => {
    const log = logger();
    const failures: Array<Record<string, unknown>> = [];
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript() {
        throw err;
      },
    };
    await expect(
      processProviderTranscriptDelete(
        job,
        {
          resolveDeleter: async () => deleter,
          resolveProviderJobId: fromDb(),
          logger: log.logger,
          onFinalFailure: (i) => failures.push(i),
        },
        { isFinalAttempt: false, jobId: 'j-reset' },
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN', retryable: true });
    expect(failures).toEqual([]);
    expect(log.blob()).not.toContain(SECRET);
  });

  it('passes the job abort signal through to the deleter', async () => {
    const log = logger();
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const deleter: ProviderTranscriptDeleter = {
      async deleteTranscript(_id, signal) {
        seen.push(signal);
        return { outcome: 'deleted', httpStatus: 200 };
      },
    };
    const processor = createProviderTranscriptDeleteProcessor({
      resolveDeleter: async () => deleter,
      resolveProviderJobId: fromDb(),
      logger: log.logger,
    });
    await processor({
      data: job,
      id: 'j-signal',
      opts: { attempts: 5 },
      attemptsMade: 0,
      signal: ac.signal,
    } as never);
    expect(seen).toEqual([ac.signal]);
  });
});

describe('registerProviderTranscriptDeleteWorker', () => {
  it('returns missing_redis when no redis URL is configured', () => {
    expect(
      registerProviderTranscriptDeleteWorker({
        redisUrl: '',
        resolveProviderJobId: async () => undefined,
      }),
    ).toEqual({ registered: false, reason: 'missing_redis' });
  });
});

describe('provider transcript delete queue name', () => {
  it('is a dedicated queue (not a colon-prefixed custom id)', () => {
    expect(PROVIDER_TRANSCRIPT_DELETE_QUEUE).toBe('ai-provider-transcript-delete');
  });
});
