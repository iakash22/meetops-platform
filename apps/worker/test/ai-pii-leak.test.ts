import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AIExecutor,
  AIError,
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  InMemoryOrgConfigStore,
  InMemoryUsageTracker,
  ModelRouter,
  ProviderRegistry,
  UsageQuotaManager,
  aiEnvSchema,
  createCredentialResolver,
  toPublicError,
  type LLMGenerateStructuredParams,
  type LLMGenerateTextParams,
  type LLMProvider,
} from '@meetops/ai-core';
import type { DatabaseClient as PrismaClient } from '@meetops/database';
import {
  ACTION_ITEMS_PROMPT_VERSION,
  MeetingSummaryError,
  ProviderError,
  SUMMARY_PROMPT_VERSION,
  createExecutorLlm,
  createPrismaActionItemsRepository,
  createPrismaSummaryRepository,
  createSummaryReadyPublisher,
  extractActionItems,
  processMeetingSummary,
  saveSummaryOnce,
  type ActionItemsRepository,
  type ExtractionWrite,
  type OrgScopedSummaryRepository,
  type SummaryReadyEvent,
  type SummaryRepository,
  type SummaryTranscript,
  type SummaryWrite,
} from '../src/ai/index.js';

/**
 * PII must not leave the data plane through side channels: logger calls, thrown errors (MeetingSummaryError,
 * ProviderError, ai-core toPublicError), recorded failure rows, outbox payloads and realtime events carry ids,
 * counts and codes only, never transcript segment text, emails, phone numbers or model text.
 * (Stored report/task content legitimately contains meeting text; that is not checked here.)
 * Current behaviour is also pinned: segment emails and phones are sent to the LLM unredacted.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ai/pii-transcript.json', import.meta.url), 'utf8'),
) as { transcript: SummaryTranscript; needles: string[] };
const t = fixture.transcript;
const ORG = '0a0a0a0a-0000-4000-8000-000000000011';
const MEETING = '0a0a0a0a-0000-4000-8000-000000000012';
const REPORT = '0a0a0a0a-0000-4000-8000-000000000013';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(\+?\d[\d ()-]{7,}\d)/;
/** Every needle, every segment text and generic email/phone patterns. */
function leaks(blob: string): string[] {
  const found = [...fixture.needles, ...t.segments.map((s) => s.text)].filter((n) =>
    blob.includes(n),
  );
  if (EMAIL.test(blob)) found.push(`email:${EMAIL.exec(blob)![0]}`);
  // UUIDs and ISO timestamps are allowed; strip them before the phone check.
  const scrubbed = blob
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');
  if (PHONE.test(scrubbed)) found.push(`phone:${PHONE.exec(scrubbed)![0]}`);
  return found;
}

function captureLogger() {
  const lines: string[] = [];
  const rec =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push(
        `${level} ${JSON.stringify(args, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v))}`,
      );
  return { logger: { info: rec('info'), warn: rec('warn'), error: rec('error') }, lines };
}

const errBlob = (e: unknown) =>
  e instanceof Error
    ? JSON.stringify({ ...e, name: e.name, message: e.message, stack: undefined })
    : JSON.stringify(e);

type Script = { text?: Array<string | Error>; structured?: Array<unknown> };
function scriptedLlm(script: Script): LLMProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    providerId: 'gemini',
    kind: 'llm',
    prompts,
    listModels: () => Promise.resolve(['m']),
    healthCheck: () => Promise.resolve({ ok: true, timestamp: 'now' }),
    generateText(p: LLMGenerateTextParams) {
      prompts.push(p.prompt);
      const n = script.text?.shift();
      if (n === undefined) return Promise.reject(new Error('no script'));
      if (n instanceof Error) return Promise.reject(n);
      return Promise.resolve({
        text: n,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    },
    generateStructured<S extends z.ZodType>(p: LLMGenerateStructuredParams<S>) {
      prompts.push(p.prompt);
      const n = script.structured?.shift();
      if (n instanceof Error) return Promise.reject(n);
      const r = p.schema.safeParse(n);
      if (!r.success)
        // Like a real adapter: the validation message may quote the model's (PII-bearing) output.
        return Promise.reject(
          new AIError('INVALID_OUTPUT', `schema: ${JSON.stringify(n)}`, {
            provider: 'gemini',
            retryable: false,
          }),
        );
      return Promise.resolve({
        value: r.data,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    },
  };
}

async function executorFor(llm: LLMProvider, onInternal?: (e: unknown) => void) {
  const audit = new InMemoryAuditSink();
  const registry = new ProviderRegistry(
    { gemini: () => llm },
    createCredentialResolver(
      { env: () => undefined, secret: () => Promise.resolve(undefined) },
      () => Promise.resolve({ platformKeys: true }),
    ),
    audit,
  );
  await registry.register(
    {
      name: 'gemini',
      type: 'llm',
      adapter: 'gemini',
      model: 'gemini-2.5-flash-lite',
      enabled: true,
      capabilities: ['text-generation', 'structured-output'],
      cost: { tier: 'free' },
      platformBilled: false,
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
    },
    { system: true, userId: 'test' },
  );
  const usage = new InMemoryUsageTracker();
  return new AIExecutor({
    registry,
    router: new ModelRouter(aiEnvSchema.parse({}), new InMemoryOrgConfigStore(), audit),
    usage,
    quota: new UsageQuotaManager(usage),
    idempotency: new InMemoryIdempotencyStore(),
    notify: () => {},
    sleep: () => Promise.resolve(),
    ...(onInternal ? { onInternalError: (e: unknown) => onInternal(e) } : {}),
  });
}

async function run(script: Script, opts: { final?: boolean } = {}) {
  const { logger, lines } = captureLogger();
  const llm = scriptedLlm(script);
  const executor = await executorFor(llm);
  const saved: SummaryWrite[] = [];
  const failures: unknown[] = [];
  const scoped: OrgScopedSummaryRepository = {
    findMeeting: (id) => Promise.resolve(id === MEETING ? { id, organizationId: ORG } : undefined),
    latestReadyTranscript: () => Promise.resolve(t),
    findSummary: () => Promise.resolve(saved.length ? { reportId: REPORT } : undefined),
    saveSummary: (w) => {
      saved.push(w);
      return Promise.resolve({ reportId: REPORT, created: true });
    },
    recordFailure: (w) => {
      failures.push(w);
      return Promise.resolve();
    },
  };
  const repository: SummaryRepository = {
    withOrgContext: (_o, fn) => fn(scoped),
    saveSummary: (o, w) => saveSummaryOnce(repository, o, w),
  };
  const writes: ExtractionWrite[] = [];
  const actions: ActionItemsRepository = {
    findExtraction: () => Promise.resolve(undefined),
    saveExtraction: (_o, w) => {
      writes.push(w);
      return Promise.resolve({ aiRunId: 'run-1', created: true, tasksCreated: w.tasks.length });
    },
  };
  const events: SummaryReadyEvent[] = [];
  const err = await processMeetingSummary(
    { organizationId: ORG, meetingId: MEETING },
    {
      llmFor: (o) =>
        createExecutorLlm(executor, {
          organizationId: o,
          feature: 'summary',
          promptVersion: SUMMARY_PROMPT_VERSION,
        }),
      repository,
      logger,
      actionItems: {
        extract: (i) => extractActionItems(i, { executor, repository: actions, logger }),
      },
      onSummaryReady: (e) => void events.push(e),
    },
    { jobId: 'job-1', isFinalAttempt: opts.final ?? true },
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { err, lines, saved, writes, events, failures, prompts: llm.prompts };
}

// A model that echoes PII back (realistic: summaries quote names, emails and numbers).
const echoSummary = JSON.stringify({
  title: 'Refund call with Priya Sharma',
  summary: `Priya (priya.sharma@acme-corp.test, +91 98765 43210) asked about card 4111 1111 1111 1111.`,
  decisions: ['Refund approved for the Hartwell acquisition account'],
  risks: [],
  actionItems: [{ title: 'Email leo.martin@example.org the refund', assigneeHint: 'Leo' }],
  tasks: [],
});
const echoItems = {
  items: [
    {
      title: 'Email the refund confirmation to priya.sharma@acme-corp.test',
      assigneeHint: 'Leo (415) 555-0134',
      dueHint: 'Friday',
      confidence: 0.9,
      sourceSegments: [3],
    },
  ],
};

describe('PII fixture sanity', () => {
  it('the transcript really contains the needles and the detectors find them', () => {
    const all = t.segments.map((s) => s.text).join(' ');
    for (const n of fixture.needles) expect(all).toContain(n);
    expect(leaks(all).some((l) => l.startsWith('email:'))).toBe(true);
    expect(leaks('call +91 98765 43210').some((l) => l.startsWith('phone:'))).toBe(true);
    expect(leaks(`id ${ORG} at 2026-11-11T10:00:00.000Z`)).toEqual([]);
  });
});

describe('success path: logs and realtime events carry ids/counts only', () => {
  it('summary + action items with a PII-echoing model', async () => {
    const r = await run({ text: [echoSummary], structured: [echoItems] });
    expect(r.err).toBeUndefined();
    expect(r.writes).toHaveLength(1);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(leaks(r.lines.join('\n'))).toEqual([]);
    expect(r.events).toHaveLength(1);
    expect(Object.keys(r.events[0]!).sort()).toEqual(
      [
        'at',
        'meetingId',
        'organizationId',
        'reportId',
        'tasksPendingReview',
        'transcriptRevision',
      ].sort(),
    );
    expect(leaks(JSON.stringify(r.events))).toEqual([]);
  });

  it('createSummaryReadyPublisher emits the event unchanged (no text added)', () => {
    const emitted: unknown[] = [];
    const emitter = { to: () => ({ emit: (_e: string, p: unknown) => void emitted.push(p) }) };
    const e: SummaryReadyEvent = {
      organizationId: ORG,
      meetingId: MEETING,
      reportId: REPORT,
      transcriptRevision: 3,
      tasksPendingReview: 1,
      at: '2026-11-11T10:00:00.000Z',
    };
    createSummaryReadyPublisher(emitter)(e);
    expect(emitted).toEqual([e]);
  });
});

describe('failure paths: errors, logs and failure rows carry codes only', () => {
  it('provider error whose message quotes the transcript', async () => {
    const providerErr = new AIError(
      'PROVIDER_UNAVAILABLE',
      `upstream echoed: ${t.segments[0]!.text}`,
      { provider: 'gemini', retryable: false },
    );
    const r = await run({ text: [providerErr] });
    expect(r.err).toBeInstanceOf(MeetingSummaryError);
    expect(leaks(errBlob(r.err))).toEqual([]);
    expect(leaks(r.lines.join('\n'))).toEqual([]);
    expect(leaks(JSON.stringify(r.failures))).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });

  it('invalid model output that echoes PII (not JSON)', async () => {
    const r = await run({
      text: [`Sure! Priya's email is priya.sharma@acme-corp.test and phone +91 98765 43210`],
    });
    expect((r.err as MeetingSummaryError).code).toBe('invalid_model_output');
    expect((r.err as Error).message).toBe('meeting summary failed: invalid_model_output');
    expect(leaks(errBlob(r.err))).toEqual([]);
    expect(leaks(r.lines.join('\n'))).toEqual([]);
    expect(leaks(JSON.stringify(r.failures))).toEqual([]);
  });

  it('action-item validation failure whose message quotes the model output', async () => {
    const bad = { items: [{ ...echoItems.items[0], status: 'approved' }] };
    const r = await run({ text: [echoSummary], structured: [bad, bad] });
    expect((r.err as MeetingSummaryError).code).toBe('provider_bad_response');
    expect(leaks(errBlob(r.err))).toEqual([]);
    expect(leaks(r.lines.join('\n'))).toEqual([]);
  });

  it('ProviderError and toPublicError expose codes, never provider messages', () => {
    const e = new ProviderError('ai-core', 'bad_response');
    expect(leaks(errBlob(e))).toEqual([]);
    const pub = toPublicError(
      new AIError('INVALID_OUTPUT', `model said ${t.segments[1]!.text}`, {
        provider: 'gemini',
        retryable: false,
      }),
      'req-1',
    );
    expect(pub).toEqual({ code: 'INVALID_OUTPUT', requestId: 'req-1', retryable: false });
  });
});

describe('outbox payloads (Prisma repositories with a fake client)', () => {
  function fakeClient() {
    const outbox: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: () => Promise.resolve(1),
      aiRun: {
        findMany: () => Promise.resolve([]),
        create: () => Promise.resolve({ id: 'run-1' }),
      },
      report: {
        findFirst: () => Promise.resolve(null),
        create: () => Promise.resolve({ id: REPORT }),
      },
      extractedTask: { createMany: () => Promise.resolve({ count: 1 }) },
      outboxEvent: {
        create: ({ data }: { data: Record<string, unknown> }) => {
          outbox.push(data);
          return Promise.resolve({});
        },
      },
    };
    const client = {
      $transaction: <T>(fn: (x: typeof tx) => Promise<T>) => fn(tx),
    } as unknown as PrismaClient;
    return { client, outbox };
  }
  const task = {
    title: 'Email the refund confirmation to priya.sharma@acme-corp.test',
    description: t.segments[2]!.text,
    priority: 'medium' as const,
    assigneeHint: 'Leo (415) 555-0134',
    dueHint: 'Friday',
    confidence: 0.9,
    sourceSegmentIds: [t.segments[3]!.id],
  };

  it('meeting.summary_ready: ids and counts only', async () => {
    const f = fakeClient();
    const repo = createPrismaSummaryRepository({ client: f.client });
    await repo.saveSummary(ORG, {
      meetingId: MEETING,
      transcriptId: t.transcriptId,
      transcriptRevision: t.revision,
      promptVersion: SUMMARY_PROMPT_VERSION,
      provider: 'gemini',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      title: 'Refund call with Priya Sharma',
      content: {
        summary: t.segments.map((s) => s.text).join(' '),
        decisions: [t.segments[4]!.text],
        risks: [],
        actionItems: [{ title: task.title, assigneeHint: task.assigneeHint }],
      },
      tasks: [task],
    });
    expect(f.outbox).toHaveLength(1);
    expect(leaks(JSON.stringify(f.outbox))).toEqual([]);
    expect(Object.keys(f.outbox[0]!.payload as object).sort()).toEqual(
      ['meetingId', 'reportId', 'tasksPendingReview', 'transcriptRevision'].sort(),
    );
  });

  it('extracted_tasks.pending_review: ids and counts only', async () => {
    const f = fakeClient();
    await createPrismaActionItemsRepository({ client: f.client }).saveExtraction(ORG, {
      meetingId: MEETING,
      reportId: REPORT,
      transcriptId: t.transcriptId,
      transcriptRevision: t.revision,
      promptVersion: ACTION_ITEMS_PROMPT_VERSION,
      provider: 'gemini',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
      tasks: [task],
    });
    expect(f.outbox).toHaveLength(1);
    expect(leaks(JSON.stringify(f.outbox))).toEqual([]);
    expect(Object.keys(f.outbox[0]!.payload as object).sort()).toEqual(
      ['aiRunId', 'count', 'kind', 'meetingId', 'reportId'].sort(),
    );
  });
});

describe('current behaviour: transcript PII is sent to the provider unredacted', () => {
  // Policy (redaction on or off) is Akash's call; this pins today's behaviour so a future
  // change is a visible test failure. The desired control remains it.todo as AI-PII-05.
  it('CURRENT BEHAVIOUR: emails and phones in segments appear verbatim in both production prompts', async () => {
    const r = await run({ text: [echoSummary], structured: [echoItems] });
    expect(r.err).toBeUndefined();
    expect(r.prompts).toHaveLength(2);
    const verbatim = [
      'priya.sharma@acme-corp.test',
      'leo.martin@example.org',
      '+91 98765 43210',
      '(415) 555-0134',
    ];
    for (const prompt of r.prompts) {
      for (const n of verbatim) expect(prompt).toContain(n);
    }
  });
});

describe('known gaps (not enforced by code today)', () => {
  it.todo(
    'PII is redacted before the transcript is sent to the LLM (phase-3-ai-notes #10: off by decision)',
  );
  it.todo('AssemblyAI redact_pii is enabled for STT (phase-3-ai-notes #7: off by decision)');
  it.todo('logger redaction covers transcript/summary text keys (REDACT_KEYS lists secrets only)');
});
