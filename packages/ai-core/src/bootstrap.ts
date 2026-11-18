import type { AIEnv } from './env.js';
import type { ProviderConfigInput } from './config.js';
import { ProviderRegistry, type AdapterFactory } from './registry.js';
import { DEFAULT_ALLOWED_HOSTS, type EndpointPolicy } from './security/ssrf.js';
import type { AuditSink } from './audit.js';
import type { SystemContext } from './auth.js';
import type { ResolveCredential } from './credentials.js';
import { GeminiProvider } from './adapters/gemini.js';
import { AssemblyAIProvider } from './adapters/assemblyai.js';
import { OllamaProvider } from './adapters/ollama.js';
import { OpenAICompatibleProvider } from './adapters/openai-compatible.js';
import { FasterWhisperProvider } from './adapters/faster-whisper.js';
import { DeepgramProvider } from './adapters/deepgram.js';
import { assertProductionProviderDataTiers, isRelaxedNodeEnv } from './provider-data-tier.js';

/**
 * Backend-controlled endpoint policy derived from env. Local origins only when that provider is enabled, and
 * NEVER in production (startup fails instead).
 */
export function endpointPolicyFromEnv(
  env: AIEnv,
  opts: { production?: boolean | undefined } = {},
): EndpointPolicy {
  const production = opts.production ?? !isRelaxedNodeEnv(process.env.NODE_ENV);
  if (production && (env.OLLAMA_ENABLED || env.LOCAL_STT_ENABLED))
    throw new Error(
      'Local AI providers (OLLAMA_ENABLED / LOCAL_STT_ENABLED) are not allowed in production',
    );
  return {
    allowedHosts: [
      ...DEFAULT_ALLOWED_HOSTS,
      ...(env.OPENAI_ENABLED ? [new URL(env.OPENAI_BASE_URL).hostname] : []),
    ],
    allowedLocalOrigins: [
      ...(env.OLLAMA_ENABLED ? [new URL(env.OLLAMA_BASE_URL).origin] : []),
      ...(env.LOCAL_STT_ENABLED ? [new URL(env.LOCAL_STT_URL).origin] : []),
    ],
  };
}

/**
 * Output caps for LLM providers: summaries and the map-reduce REDUCE step get 4096 tokens; extraction and MAP steps
 * keep the 2048 default (eval: no truncation at 2048 on the fixtures). All values are <= HARD_MAX_OUTPUT_TOKENS (schema-checked).
 */
export const SUMMARY_OUTPUT_LIMITS = {
  defaultMaxTokens: 2048,
  perFeature: { summary: 4096 },
  perStep: { map: 2048, reduce: 4096 },
} as const;

/** Default provider definitions. Credentials are referenced, never embedded; cost tier is explicit. */
export function defaultProviderConfigs(env: AIEnv): ProviderConfigInput[] {
  return [
    {
      name: 'gemini',
      type: 'llm',
      adapter: 'gemini',
      model: env.GEMINI_MODEL,
      enabled: true,
      credentialRef: 'env:GEMINI_API_KEY',
      capabilities: ['text-generation', 'structured-output'],
      languages: ['en', 'hi', 'auto'],
      inputLimits: { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 },
      timeoutMs: 60_000,
      outputLimits: SUMMARY_OUTPUT_LIMITS,
      cost: { tier: 'free' },
      platformBilled: true,
      usage: { dailyRequestLimit: 1000 },
      fallbackPriority: 10,
    },
    {
      name: 'assemblyai',
      type: 'stt',
      adapter: 'assemblyai',
      model: 'universal',
      enabled: true,
      credentialRef: 'env:ASSEMBLYAI_API_KEY',
      capabilities: ['batch-transcription', 'diarization'],
      languages: ['en', 'hi', 'auto'],
      timeoutMs: 15 * 60_000,
      cost: { tier: 'free' },
      platformBilled: true,
      usage: { monthlyAudioSecondsLimit: 5 * 3600 },
      fallbackPriority: 10,
    },
    {
      name: 'ollama',
      type: 'llm',
      adapter: 'ollama',
      model: env.OLLAMA_MODEL,
      enabled: env.OLLAMA_ENABLED,
      local: true,
      baseUrl: env.OLLAMA_BASE_URL,
      capabilities: ['text-generation', 'structured-output'],
      timeoutMs: 120_000,
      outputLimits: SUMMARY_OUTPUT_LIMITS,
      cost: { tier: 'free' },
      platformBilled: false,
      fallbackPriority: 50,
    },
    {
      name: 'faster-whisper',
      type: 'stt',
      adapter: 'faster-whisper',
      model: env.LOCAL_STT_MODEL,
      enabled: env.LOCAL_STT_ENABLED,
      local: true,
      baseUrl: env.LOCAL_STT_URL,
      capabilities: ['batch-transcription'],
      timeoutMs: 20 * 60_000,
      cost: { tier: 'free' },
      platformBilled: false,
      fallbackPriority: 50,
    },
    {
      name: 'openai',
      type: 'llm',
      adapter: 'openai-compatible',
      model: env.OPENAI_MODEL,
      enabled: env.OPENAI_ENABLED,
      credentialRef: 'env:OPENAI_API_KEY',
      baseUrl: env.OPENAI_BASE_URL,
      capabilities: ['text-generation', 'structured-output'],
      outputLimits: SUMMARY_OUTPUT_LIMITS,
      cost: { tier: 'paid', currency: 'USD', inputPer1MTokens: 0.15, outputPer1MTokens: 0.6 },
      platformBilled: true,
      fallbackPriority: 90,
    },
    {
      name: 'deepgram',
      type: 'stt',
      adapter: 'deepgram',
      model: 'nova-3',
      enabled: false,
      credentialRef: 'env:DEEPGRAM_API_KEY',
      capabilities: [],
      cost: { tier: 'paid', currency: 'USD' },
      platformBilled: true,
      fallbackPriority: 95,
    },
  ];
}

/** Factories build a fresh adapter per call with the per-org credential. */
export function defaultAdapterFactories(policy: EndpointPolicy): Record<string, AdapterFactory> {
  return {
    gemini: (c, key, o) =>
      new GeminiProvider({ apiKey: key, policy, outputLimits: o?.outputLimits }, c.name),
    assemblyai: (c, key) => new AssemblyAIProvider({ apiKey: key, policy }, c.name),
    ollama: (c, _key, o) =>
      new OllamaProvider(
        { baseUrl: c.baseUrl ?? '', policy, outputLimits: o?.outputLimits },
        c.name,
      ),
    'openai-compatible': (c, key, o) =>
      new OpenAICompatibleProvider(
        { baseUrl: c.baseUrl ?? '', policy, apiKey: key, outputLimits: o?.outputLimits },
        c.name,
      ),
    'faster-whisper': (c) =>
      new FasterWhisperProvider({ baseUrl: c.baseUrl ?? '', policy, model: c.model }, c.name),
    deepgram: () => new DeepgramProvider(),
  };
}

export async function createRegistryFromEnv(
  env: AIEnv,
  deps: {
    audit: AuditSink;
    resolveCredential: ResolveCredential;
    system: SystemContext;
    production?: boolean | undefined;
    /** Process env (or a test double) for `AI_PROVIDER_DATA_TIER_*` declarations. */
    processEnv?: Record<string, string | undefined> | undefined;
  },
) {
  const processEnv = deps.processEnv ?? process.env;
  const production = deps.production ?? !isRelaxedNodeEnv(processEnv.NODE_ENV);
  const policy = endpointPolicyFromEnv(env, { production });
  const configs = defaultProviderConfigs(env);
  assertProductionProviderDataTiers(configs, processEnv, { production });
  const reg = new ProviderRegistry(
    defaultAdapterFactories(policy),
    deps.resolveCredential,
    deps.audit,
  );
  for (const c of configs) await reg.register(c, deps.system);
  return reg;
}
