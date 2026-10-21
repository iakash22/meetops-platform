import type { AIEnv } from './env.js';
import type { ProviderConfigInput } from './config.js';
import { ProviderRegistry, envCredentialResolver, type AdapterFactory } from './registry.js';
import { DEFAULT_ALLOWED_HOSTS, type EndpointPolicy } from './security/ssrf.js';
import type { AuditSink } from './audit.js';
import { GeminiProvider } from './adapters/gemini.js';
import { AssemblyAIProvider } from './adapters/assemblyai.js';
import { OllamaProvider } from './adapters/ollama.js';
import { OpenAICompatibleProvider } from './adapters/openai-compatible.js';
import { FasterWhisperProvider } from './adapters/faster-whisper.js';
import { DeepgramProvider } from './adapters/deepgram.js';

/** Backend-controlled endpoint policy derived from env (local origins only when enabled). */
export function endpointPolicyFromEnv(env: AIEnv): EndpointPolicy {
  return {
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...(env.OPENAI_ENABLED ? [new URL(env.OPENAI_BASE_URL).hostname] : [])],
    allowedLocalOrigins: [
      ...(env.OLLAMA_ENABLED ? [new URL(env.OLLAMA_BASE_URL).origin] : []),
      ...(env.LOCAL_STT_ENABLED ? [new URL(env.LOCAL_STT_URL).origin] : []),
    ],
  };
}

/** Default provider definitions. Credentials are referenced, never embedded. */
export function defaultProviderConfigs(env: AIEnv): ProviderConfigInput[] {
  return [
    {
      name: 'gemini', type: 'llm', adapter: 'gemini', model: env.GEMINI_MODEL, enabled: true, credentialRef: 'env:GEMINI_API_KEY',
      capabilities: ['text-generation', 'structured-output', 'audio-understanding'], languages: ['en', 'hi', 'auto'],
      inputLimits: { maxInputTokens: 1_048_576, maxOutputTokens: 65_536 }, timeoutMs: 60_000,
      cost: { tier: 'free' }, usage: {}, fallbackPriority: 10,
    },
    {
      name: 'assemblyai', type: 'stt', adapter: 'assemblyai', model: 'universal', enabled: true, credentialRef: 'env:ASSEMBLYAI_API_KEY',
      capabilities: ['batch-transcription', 'diarization'], languages: ['en', 'hi', 'auto'], timeoutMs: 15 * 60_000,
      cost: { tier: 'free' }, fallbackPriority: 10,
    },
    {
      name: 'ollama', type: 'llm', adapter: 'ollama', model: env.OLLAMA_MODEL, enabled: env.OLLAMA_ENABLED, local: true,
      baseUrl: env.OLLAMA_BASE_URL, capabilities: ['text-generation', 'structured-output'], timeoutMs: 120_000,
      cost: { tier: 'free' }, fallbackPriority: 50,
    },
    {
      name: 'faster-whisper', type: 'stt', adapter: 'faster-whisper', model: env.LOCAL_STT_MODEL, enabled: env.LOCAL_STT_ENABLED,
      local: true, baseUrl: env.LOCAL_STT_URL, capabilities: ['batch-transcription'], timeoutMs: 20 * 60_000,
      cost: { tier: 'free' }, fallbackPriority: 50,
    },
    {
      name: 'openai', type: 'llm', adapter: 'openai-compatible', model: env.OPENAI_MODEL, enabled: env.OPENAI_ENABLED,
      credentialRef: 'env:OPENAI_API_KEY', baseUrl: env.OPENAI_BASE_URL, capabilities: ['text-generation', 'structured-output'],
      cost: { tier: 'paid', currency: 'USD', inputPer1MTokens: 0.15, outputPer1MTokens: 0.6 }, fallbackPriority: 90,
    },
    {
      name: 'deepgram', type: 'stt', adapter: 'deepgram', model: 'nova-3', enabled: false, credentialRef: 'env:DEEPGRAM_API_KEY',
      capabilities: [], cost: { tier: 'paid', currency: 'USD' }, fallbackPriority: 95,
    },
  ];
}

export function defaultAdapterFactories(policy: EndpointPolicy): Record<string, AdapterFactory> {
  return {
    gemini: (c, key) => new GeminiProvider({ apiKey: key }, c.name),
    assemblyai: (c, key) => new AssemblyAIProvider({ apiKey: key }, c.name),
    ollama: (c) => new OllamaProvider({ baseUrl: c.baseUrl ?? '', policy }, c.name),
    'openai-compatible': (c, key) => new OpenAICompatibleProvider({ baseUrl: c.baseUrl ?? '', policy, apiKey: key }, c.name),
    'faster-whisper': (c) => new FasterWhisperProvider({ baseUrl: c.baseUrl ?? '', policy, model: c.model }, c.name),
    deepgram: () => new DeepgramProvider(),
  };
}

export function createRegistryFromEnv(env: AIEnv, rawEnv: Record<string, string | undefined> = process.env, audit?: AuditSink) {
  const policy = endpointPolicyFromEnv(env);
  const reg = new ProviderRegistry(defaultAdapterFactories(policy), envCredentialResolver(rawEnv), audit);
  for (const c of defaultProviderConfigs(env)) reg.register(c);
  return reg;
}
