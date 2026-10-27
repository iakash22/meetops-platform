import { beforeEach, describe, expect, it, vi } from 'vitest';

const bull = vi.hoisted(() => ({
  workers: [] as Array<{
    queue: string;
    processor: (job: unknown) => Promise<unknown>;
    opts: { concurrency: number };
    handlers: Record<string, (...a: unknown[]) => void>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('ioredis', () => ({
  Redis: class {
    disconnect() {}
  },
}));
vi.mock('bullmq', async (orig) => {
  const real = await orig<typeof import('bullmq')>();
  class Worker {
    handlers: Record<string, (...a: unknown[]) => void> = {};
    close = vi.fn(async () => {});
    constructor(
      readonly queue: string,
      readonly processor: (job: unknown) => Promise<unknown>,
      readonly opts: { concurrency: number },
    ) {
      bull.workers.push(this);
    }
    on(ev: string, fn: (...a: unknown[]) => void) {
      this.handlers[ev] = fn;
      return this;
    }
  }
  return { ...real, Worker };
});

import { UnrecoverableError } from 'bullmq';
import {
  createSummaryQueueProcessor,
  loadSummaryWorkerEnv,
  registerSummaryWorker,
  saveSummaryOnce,
  startSummaryWorker,
  SUMMARY_JOB_NAME,
  SUMMARY_QUEUE,
  SummaryWorkerEnvError,
  type LlmProvider,
  type OrgScopedSummaryRepository,
  type SummaryRepository,
  type SummaryTranscript,
  type SummaryWrite,
} from '../src/ai/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEETING = '22222222-2222-4222-8222-222222222222';
const SECRET = 'sk-test-DO-NOT-LOG-123';
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const transcript: SummaryTranscript = {
  transcriptId: '44444444-4444-4444-8444-444444444444',
  recordingId: '55555555-5555-4555-8555-555555555555',
  revision: 3,
  language: 'en',
  segments: [
    {
      id: '33333333-3333-4333-8333-000000000000',
      sequence: 0,
      speakerLabel: 'A',
      startMs: 0,
      endMs: 1000,
      text: 'Ship Friday.',
    },
  ],
};
const output = JSON.stringify({
  title: 'Sync',
  summary: 'Ship Friday.',
  decisions: ['Ship Friday'],
  risks: [],
  actionItems: [],
  tasks: [{ title: 'Notes', priority: 'low', confidence: 0.8, sourceSegments: [0] }],
});

function mockLlm(result: string | Error): LlmProvider & { calls: number } {
  return {
    id: 'mock',
    model: 'mock-1',
    calls: 0,
    async generateJson() {
      this.calls++;
      if (result instanceof Error) throw result;
      return {
        provider: 'mock',
        model: 'mock-1',
        text: result,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  };
}
function mockRepo() {
  const saved: SummaryWrite[] = [];
  const scoped: OrgScopedSummaryRepository = {
    findMeeting: async (id) => (id === MEETING ? { id, organizationId: ORG } : undefined),
    latestReadyTranscript: async () => transcript,
    findSummary: async () => (saved.length ? { reportId: 'rep1' } : undefined),
    saveSummary: async (w) => (saved.push(w), { reportId: 'rep1', created: true }),
    recordFailure: async () => {},
  };
  const repository: SummaryRepository = {
    withOrgContext: (_o, fn) => fn(scoped),
    saveSummary: (o, w) => saveSummaryOnce(repository, o, w),
  };
  return { repository, saved };
}
const job = (over: Record<string, unknown> = {}) => ({
  id: `summary__${MEETING}__r3__meeting-summary@1`,
  name: SUMMARY_JOB_NAME,
  data: { organizationId: ORG, meetingId: MEETING },
  attemptsMade: 0,
  opts: { attempts: 3 },
  ...over,
});

beforeEach(() => void (bull.workers.length = 0));

describe('ai queue processor (summarize_meeting)', () => {
  it('runs the summary job with the mocked provider and saves once; replays are duplicates', async () => {
    const llm = mockLlm(output);
    const { repository, saved } = mockRepo();
    const p = createSummaryQueueProcessor({ llm, repository, logger: silent });
    await expect(p(job())).resolves.toMatchObject({
      reportId: 'rep1',
      duplicate: false,
      tasksCreated: 1,
      transcriptRevision: 3,
    });
    await expect(p(job())).resolves.toMatchObject({ duplicate: true, tasksCreated: 0 });
    expect(saved).toHaveLength(1);
    expect(llm.calls).toBe(1);
  });
  it('rejects unknown job names as unrecoverable without calling the provider', async () => {
    const llm = mockLlm(output);
    const p = createSummaryQueueProcessor({
      llm,
      repository: mockRepo().repository,
      logger: silent,
    });
    await expect(p(job({ name: 'other' }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(llm.calls).toBe(0);
  });
  it('invalid payload is unrecoverable', async () => {
    const p = createSummaryQueueProcessor({
      llm: mockLlm(output),
      repository: mockRepo().repository,
      logger: silent,
    });
    await expect(p(job({ data: { meetingId: 'nope' } }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('startSummaryWorker', () => {
  it('consumes QUEUE_NAMES.ai with configured concurrency and drains on close', async () => {
    const warn = vi.fn();
    const w = startSummaryWorker(
      { concurrency: 4, redisUrl: 'redis://x' },
      { llm: mockLlm(output), repository: mockRepo().repository, logger: { ...silent, warn } },
    );
    const bw = bull.workers[0]!;
    expect(bw.queue).toBe(SUMMARY_QUEUE);
    expect(bw.opts.concurrency).toBe(4);
    await expect(bw.processor(job())).resolves.toMatchObject({ reportId: 'rep1' });
    bw.handlers.failed!({ id: 'j1' }, new Error('x'));
    expect(warn).toHaveBeenCalledWith(
      { jobId: 'j1', errorCode: 'Error' },
      'summary job attempt failed',
    );
    await w.close();
    expect(bw.close).toHaveBeenCalledOnce();
  });
});

describe('registerSummaryWorker (provider-gated)', () => {
  const logs = () => {
    const lines: Array<[string, object, string]> = [];
    return {
      lines,
      logger: {
        info: (o: object, m: string) => void lines.push(['info', o, m]),
        warn: (o: object, m: string) => void lines.push(['warn', o, m]),
      },
    };
  };
  it('does not start and warns exactly once when GEMINI_API_KEY is missing', () => {
    const { lines, logger } = logs();
    const start = vi.fn();
    const r = registerSummaryWorker({ env: { GEMINI_MODEL: 'x' }, start, logger });
    expect(r).toEqual({ registered: false, reason: 'llm_not_configured' });
    expect(start).not.toHaveBeenCalled();
    expect(lines).toEqual([
      [
        'warn',
        { worker: SUMMARY_QUEUE, missing: ['GEMINI_API_KEY'] },
        'ai summary worker not started: LLM provider not configured',
      ],
    ]);
  });
  it('blank key counts as missing', () => {
    const { logger } = logs();
    expect(
      registerSummaryWorker({ env: { GEMINI_API_KEY: '  ' }, start: vi.fn(), logger }),
    ).toMatchObject({ registered: false });
  });
  it('invalid provider config does not start and never logs values', () => {
    const { lines, logger } = logs();
    const r = registerSummaryWorker({
      env: { GEMINI_API_KEY: SECRET, GEMINI_BASE_URL: 'http://evil.example' },
      start: vi.fn(),
      logger,
    });
    expect(r).toEqual({ registered: false, reason: 'llm_config_invalid' });
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.stringify(lines)).not.toContain('evil');
  });
  it('starts with the configured provider, concurrency and limits; logs no secret', async () => {
    const { lines, logger } = logs();
    const close = vi.fn(async () => {});
    const start = vi.fn(() => ({ worker: {} as never, close }));
    const llm = mockLlm(output);
    const createLlm = vi.fn<(cfg: { apiKey: string }) => LlmProvider>(() => llm);
    const { repository } = mockRepo();
    const r = registerSummaryWorker({
      env: {
        GEMINI_API_KEY: SECRET,
        AI_SUMMARY_WORKER_CONCURRENCY: '2',
        REDIS_URL: 'redis://r:6379',
        AI_SUMMARY_MAX_OUTPUT_TOKENS: '1024',
      },
      start,
      createLlm,
      createRepository: () => repository,
      logger,
    });
    expect(r.registered).toBe(true);
    expect(createLlm.mock.calls[0]![0]).toMatchObject({ apiKey: SECRET });
    expect(start).toHaveBeenCalledWith(
      { concurrency: 2, redisUrl: 'redis://r:6379' },
      expect.objectContaining({
        llm,
        repository,
        limits: expect.objectContaining({ maxOutputTokens: 1024 }),
      }),
    );
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    if (r.registered) await r.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('loadSummaryWorkerEnv', () => {
  it('defaults to concurrency 1 and local redis', () => {
    expect(loadSummaryWorkerEnv({})).toEqual({
      concurrency: 1,
      redisUrl: 'redis://localhost:6379',
    });
  });
  it.each(['0', '9', 'abc', '-1'])('rejects concurrency %s by key name', (v) => {
    expect(() => loadSummaryWorkerEnv({ AI_SUMMARY_WORKER_CONCURRENCY: v })).toThrow(
      SummaryWorkerEnvError,
    );
    expect(() => loadSummaryWorkerEnv({ AI_SUMMARY_WORKER_CONCURRENCY: v })).toThrow(
      /^AI_SUMMARY_WORKER_CONCURRENCY/,
    );
  });
});
