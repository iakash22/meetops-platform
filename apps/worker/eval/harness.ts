import {
  AIExecutor,
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  InMemoryOrgConfigStore,
  InMemoryUsageTracker,
  ModelRouter,
  ProviderRegistry,
  UsageQuotaManager,
  loadAIEnv,
  createCredentialResolver,
  type LLMProvider,
} from '@meetops/ai-core';
import { Value } from '@sinclair/typebox/value';
import { ReportContent } from '@meetops/contracts';
import {
  extractActionItems,
  type ActionItemsRepository,
  type ExtractionWrite,
} from '../src/ai/action-items.js';
import { createExecutorLlm } from '../src/ai/executor-llm.js';
import {
  SUMMARY_PROMPT_VERSION,
  parseSummaryOutput,
  processMeetingSummary,
} from '../src/ai/meeting-summary.js';
import {
  saveSummaryOnce,
  type OrgScopedSummaryRepository,
  type SummaryRepository,
  type SummaryWrite,
} from '../src/ai/summary-repository.js';
import type { EvalFixture } from './load.js';

export type { EvalFixture } from './load.js';

export const EVAL_ORG = '0e0e0e0e-0000-4000-8000-000000000001';
export const EVAL_MEETING = '0e0e0e0e-0000-4000-8000-000000000002';
const REPORT = '0e0e0e0e-0000-4000-8000-000000000003';
const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Mock provider registered as `gemini` in a REAL ai-core registry/router/executor (in-memory stores, no network). */
export async function evalExecutor(llm: LLMProvider): Promise<AIExecutor> {
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
    { system: true, userId: 'eval' },
  );
  const usage = new InMemoryUsageTracker();
  return new AIExecutor({
    registry,
    router: new ModelRouter(
      loadAIEnv({ NODE_ENV: 'test' }).env,
      new InMemoryOrgConfigStore(),
      audit,
    ),
    usage,
    quota: new UsageQuotaManager(usage),
    idempotency: new InMemoryIdempotencyStore(),
    notify: () => {},
    sleep: () => Promise.resolve(),
  });
}

export type EvalRun = {
  ok: boolean;
  errorCode?: string | undefined;
  summary?: SummaryWrite | undefined;
  extraction?: ExtractionWrite | undefined;
  /** The raw summary text parses into the strict LlmSummaryOutput schema. */
  summaryRawValid: boolean;
  /** The persisted report content passes the contracts ReportContent schema. */
  reportContentValid: boolean;
};

/**
 * Runs the PRODUCTION path for one fixture: processMeetingSummary (meeting-summary@1, generateText through the
 * executor, feature `summary`) followed by extractActionItems (action-items@1, generateStructured, feature
 * `actions`), with in-memory repositories in place of Prisma.
 */
export async function runFixture(
  fx: EvalFixture,
  llm: LLMProvider & { lastSummaryRaw?: string | undefined },
): Promise<EvalRun> {
  const executor = await evalExecutor(llm);
  const saved: SummaryWrite[] = [];
  const scoped: OrgScopedSummaryRepository = {
    findMeeting: (id) =>
      Promise.resolve(id === EVAL_MEETING ? { id, organizationId: EVAL_ORG } : undefined),
    latestReadyTranscript: () => Promise.resolve(fx.transcript),
    findSummary: () => Promise.resolve(saved.length ? { reportId: REPORT } : undefined),
    saveSummary: (w) => {
      saved.push(w);
      return Promise.resolve({ reportId: REPORT, created: true });
    },
    recordFailure: () => Promise.resolve(),
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
      return Promise.resolve({ aiRunId: 'eval-run', created: true, tasksCreated: w.tasks.length });
    },
  };
  let errorCode: string | undefined;
  try {
    await processMeetingSummary(
      { organizationId: EVAL_ORG, meetingId: EVAL_MEETING },
      {
        llmFor: (o) =>
          createExecutorLlm(executor, {
            organizationId: o,
            feature: 'summary',
            promptVersion: SUMMARY_PROMPT_VERSION,
          }),
        repository,
        logger: silent,
        actionItems: {
          extract: (i) => extractActionItems(i, { executor, repository: actions, logger: silent }),
        },
      },
      { isFinalAttempt: true },
    );
  } catch (err) {
    errorCode = (err as { code?: string }).code ?? (err as Error).name;
  }
  const summary = saved[0];
  return {
    ok: errorCode === undefined,
    errorCode,
    summary,
    extraction: writes[0],
    summaryRawValid:
      llm.lastSummaryRaw !== undefined && parseSummaryOutput(llm.lastSummaryRaw) !== undefined,
    reportContentValid: summary !== undefined && Value.Check(ReportContent, summary.content),
  };
}
