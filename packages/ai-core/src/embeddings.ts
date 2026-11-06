import { AIError } from './errors.js';
import type { AIExecutor, AttemptError } from './executor.js';
import { hasEmbeddings, type AIUsage } from './types.js';

/** Vector size of meeting_embeddings (pgvector `vector(1536)`). Other sizes are refused, never padded. */
export const EMBEDDING_DIMS = 1536;
/** Inputs per provider call. */
export const EMBEDDING_MAX_BATCH = 32;
/** Characters per input; longer text is truncated before embedding. */
export const EMBEDDING_MAX_INPUT_CHARS = 8000;
/** Bump when the embedding input shaping changes (part of the idempotency key). */
export const EMBEDDING_PROMPT_VERSION = 'embed-v1';

/** Config/policy outcomes: nothing is routed or allowed for embeddings (not worth retrying until config changes). */
const UNCONFIGURED: ReadonlySet<string> = new Set([
  'CAPABILITY_UNSUPPORTED',
  'PROVIDER_DISABLED',
  'MISSING_CREDENTIALS',
  'UNAUTHORIZED_OVERRIDE',
  'PAID_FALLBACK_BLOCKED',
  'CONFIG_INVALID',
]);

export type EmbedBatchResult =
  | { status: 'succeeded'; vectors: number[][]; model: string; usage: AIUsage; cached: boolean }
  | { status: 'unavailable' | 'retryable' | 'failed'; errors: AttemptError[] };

/**
 * Embeds a batch through the AIExecutor ('embeddings' feature): routing, approval/paid-fallback policy, quotas, usage
 * tracking and idempotency all apply. `model` in the result is `provider/model`, the value stored with each vector
 * and used to match query vectors. A provider without the Embeddings capability (every default today) is
 * `unavailable`, so nothing is embedded until an approved provider is routed for the feature.
 */
export async function embedWithExecutor(
  executor: Pick<AIExecutor, 'run'>,
  req: { organizationId: string; inputs: string[]; idempotencyKey?: string; jobId?: string },
): Promise<EmbedBatchResult> {
  if (req.inputs.length === 0 || req.inputs.length > EMBEDDING_MAX_BATCH)
    throw new RangeError(`embedding batch must have 1..${EMBEDDING_MAX_BATCH} inputs`);
  const inputs = req.inputs.map((t) => t.slice(0, EMBEDDING_MAX_INPUT_CHARS));
  const out = await executor.run<number[][]>(
    {
      organizationId: req.organizationId,
      feature: 'embeddings',
      promptVersion: EMBEDDING_PROMPT_VERSION,
      ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
      ...(req.jobId ? { jobId: req.jobId } : {}),
    },
    async (provider, ctx) => {
      if (!hasEmbeddings(provider))
        throw new AIError('CAPABILITY_UNSUPPORTED', 'provider has no embeddings', {
          provider: ctx.config.name,
        });
      const r = await provider.embed({ model: ctx.model, inputs });
      if (
        r.vectors.length !== inputs.length ||
        !r.vectors.every((v) => v.length === EMBEDDING_DIMS && v.every((x) => Number.isFinite(x)))
      )
        throw new AIError('INVALID_OUTPUT', 'embedding size mismatch', {
          provider: ctx.config.name,
        });
      return { value: r.vectors, usage: r.usage };
    },
  );
  if (out.status === 'succeeded')
    return {
      status: 'succeeded',
      vectors: out.value,
      model: `${out.meta.provider}/${out.meta.model}`,
      usage: out.meta.usage,
      cached: out.meta.cached === true,
    };
  const unavailable = out.errors.length > 0 && out.errors.every((e) => UNCONFIGURED.has(e.code));
  return {
    status: unavailable
      ? 'unavailable'
      : out.status === 'retryable' || out.status === 'waiting'
        ? 'retryable'
        : 'failed',
    errors: out.errors,
  };
}
