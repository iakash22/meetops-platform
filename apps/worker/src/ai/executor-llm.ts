import type { AIExecutor, AIFeature, AttemptError, LLMProvider } from '@meetops/ai-core';
import { ProviderError } from './providers/errors.js';
import type {
  LlmJsonRequest,
  LlmJsonResult,
  LlmProvider,
  LlmUsage,
} from './providers/llm-provider.js';

export const EXECUTOR_PROVIDER_ID = 'ai-core';

export type ExecutorLlmOptions = {
  organizationId: string;
  feature: AIFeature;
  promptVersion: string;
  jobId?: string | undefined;
};

/** Narrow to the ai-core executor surface the worker uses (tests pass a stub). */
export type ExecutorLike = Pick<AIExecutor, 'run'>;

const isLlm = (p: unknown): p is LLMProvider =>
  typeof (p as Partial<LLMProvider>)?.generateText === 'function' &&
  typeof (p as Partial<LLMProvider>)?.generateStructured === 'function';

/**
 * Maps a non-success executor outcome to the worker's provider error taxonomy. Only provider ids + codes are kept
 * (no provider messages). `waiting`/`retryable` stay retryable; `failed` (incl. PAID_FALLBACK_BLOCKED,
 * MISSING_CREDENTIALS, PROVIDER_DISABLED) is terminal so BullMQ does not burn attempts.
 */
export function outcomeError(status: string, errors: AttemptError[]): ProviderError {
  if (status === 'waiting' || status === 'retryable') {
    const rl = errors.some((e) => e.code === 'RATE_LIMITED' || e.code === 'QUOTA_EXCEEDED');
    return new ProviderError(EXECUTOR_PROVIDER_ID, rl ? 'rate_limited' : 'unavailable');
  }
  if (errors.some((e) => e.code === 'INVALID_OUTPUT'))
    return new ProviderError(EXECUTOR_PROVIDER_ID, 'bad_response');
  return new ProviderError(EXECUTOR_PROVIDER_ID, 'provider_failed');
}

const usageOf = (u: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): LlmUsage => ({
  inputTokens: u.inputTokens ?? null,
  outputTokens: u.outputTokens ?? null,
  totalTokens: u.totalTokens ?? null,
});

/**
 * Worker LlmProvider backed by the ai-core executor: provider choice goes through the registry + ModelRouter
 * (Gemini by default, switchable by AI_* env / org config), with ai-core's SSRF guard, quota and the
 * no-paid-fallback policy (AI_ALLOW_PAID_FALLBACK defaults to false). Callers cannot pass endpoints.
 */
export function createExecutorLlm(executor: ExecutorLike, opts: ExecutorLlmOptions): LlmProvider {
  return {
    id: EXECUTOR_PROVIDER_ID,
    model: 'routed',
    async generateJson(req: LlmJsonRequest): Promise<LlmJsonResult> {
      const out = await executor.run(
        {
          organizationId: opts.organizationId,
          feature: opts.feature,
          promptVersion: opts.promptVersion,
          jobId: opts.jobId,
        },
        async (provider, ctx) => {
          if (!isLlm(provider)) throw new ProviderError(EXECUTOR_PROVIDER_ID, 'invalid_request');
          const r = await provider.generateText({
            model: ctx.model,
            system: req.system,
            prompt: req.user,
            maxTokens: req.maxOutputTokens,
            temperature: req.temperature,
            signal: req.signal ?? ctx.signal,
          });
          return { value: r.text, usage: r.usage };
        },
      );
      if (out.status !== 'succeeded') throw outcomeError(out.status, out.errors);
      return {
        provider: out.meta.provider,
        model: out.meta.model,
        text: out.value,
        usage: usageOf(out.meta.usage),
      };
    },
  };
}
