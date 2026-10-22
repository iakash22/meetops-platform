import { z } from 'zod';
import { parseCredentialRef } from './credential-ref.js';
import { CAPABILITIES } from './types.js';

export const capabilitySchema = z.enum(CAPABILITIES);

export const retryPolicySchema = z
  .object({
    /** Hard-bounded: at most 5 attempts in total. Infinite retries are impossible by schema. */
    maxAttempts: z.number().int().min(1).max(5).default(3),
    initialDelayMs: z.number().int().min(0).max(30_000).default(500),
    maxDelayMs: z.number().int().min(0).max(120_000).default(8_000),
    backoffMultiplier: z.number().min(1).max(10).default(2),
  })
  .refine((r) => r.maxDelayMs >= r.initialDelayMs, { message: 'maxDelayMs must be >= initialDelayMs' });
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const costSchema = z.discriminatedUnion('tier', [
  z.object({ tier: z.literal('free') }),
  z.object({
    tier: z.literal('paid'),
    currency: z.literal('USD').default('USD'),
    inputPer1MTokens: z.number().min(0).optional(),
    outputPer1MTokens: z.number().min(0).optional(),
    perAudioHour: z.number().min(0).optional(),
  }),
]);
export type ProviderCost = z.infer<typeof costSchema>;

/**
 * Reference to a credential held in a secret store / env. NEVER the secret itself.
 * Format: "env:VAR_NAME" or "secret:<path>"; parsed strictly by parseCredentialRef (credential-ref.ts).
 */
export const credentialRefSchema = z
  .string()
  .refine((r) => parseCredentialRef(r) !== null, 'credentialRef must be "env:NAME" or "secret:seg/seg", never a raw key');

export const providerConfigSchema = z
  .object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  type: z.enum(['llm', 'stt']),
  /** Adapter implementation id, e.g. "gemini", "assemblyai", "ollama", "openai-compatible", "faster-whisper", "deepgram". */
  adapter: z.string().min(1),
  model: z.string().min(1),
  enabled: z.boolean().default(false),
  credentialRef: credentialRefSchema.optional(),
  baseUrl: z.string().url().optional(),
  /** True for self-hosted providers (Ollama, faster-whisper) that may live on private networks. */
  local: z.boolean().default(false),
  capabilities: z.array(capabilitySchema).default([]),
  languages: z.array(z.string()).default(['en']),
  inputLimits: z
    .object({
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      maxAudioSeconds: z.number().int().positive().optional(),
      maxFileBytes: z.number().int().positive().optional(),
    })
    .default({}),
  concurrency: z.number().int().min(1).max(256).default(4),
  timeoutMs: z.number().int().min(100).max(30 * 60_000).default(60_000),
  retryPolicy: retryPolicySchema.default({ maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, backoffMultiplier: 2 }),
  /** REQUIRED: every provider must declare its cost tier explicitly (no implicit 'free'). */
  cost: costSchema,
  /** True when the platform pays for usage (platform keys). Budgets/quotas apply even to free-tier providers. */
  platformBilled: z.boolean(),
  usage: z
    .object({
      dailyRequestLimit: z.number().int().positive().optional(),
      dailyTokenLimit: z.number().int().positive().optional(),
      monthlyAudioSecondsLimit: z.number().int().positive().optional(),
    })
    .default({}),
  health: z
    .object({
      status: z.enum(['unknown', 'healthy', 'degraded', 'unavailable']).default('unknown'),
      reason: z.string().optional(),
      checkedAt: z.string().optional(),
    })
    .default({ status: 'unknown' }),
  /** Lower number = tried earlier in fallback chains. */
  fallbackPriority: z.number().int().min(0).max(1000).default(100),
  })
  .refine(
    (c) => !(c.platformBilled && c.cost.tier === 'free') || Object.values(c.usage).some((v) => v !== undefined),
    { message: 'platformBilled free-tier providers must declare usage limits (quotas apply even when free)', path: ['usage'] },
  );
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderConfigInput = z.input<typeof providerConfigSchema>;

/** Shape safe to send to a frontend: no credentialRef, no baseUrl internals. */
export type PublicProviderConfig = Omit<ProviderConfig, 'credentialRef' | 'baseUrl'> & { hasCredential: boolean };

export function toPublicProviderConfig(c: ProviderConfig): PublicProviderConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { credentialRef, baseUrl, ...rest } = c;
  return { ...rest, hasCredential: credentialRef !== undefined };
}
