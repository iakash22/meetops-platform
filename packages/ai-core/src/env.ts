import { z } from 'zod';
import { isRelaxedNodeEnv } from './provider-data-tier.js';
import {
  assemblyAiSpeechModelsFromEnv,
  DEFAULT_ASSEMBLYAI_SPEECH_MODELS,
  InvalidAssemblyAiSpeechModelsError,
  type AssemblyAiSpeechModel,
} from './assemblyai-speech-models.js';

export {
  ASSEMBLYAI_PRE_RECORDED_SPEECH_MODELS,
  DEFAULT_ASSEMBLYAI_SPEECH_MODELS,
  InvalidAssemblyAiSpeechModelsError,
  assemblyAiSpeechModelsFromEnv,
  parseAssemblyAiSpeechModels,
  type AssemblyAiSpeechModel,
} from './assemblyai-speech-models.js';

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v),
    );

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const aiEnvSchema = z.object({
  AI_LLM_PROVIDER: z.enum(['gemini', 'ollama', 'openai']).default('gemini'),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash-lite'),
  GEMINI_API_KEY: optStr,
  AI_STT_PROVIDER: z
    .enum(['assemblyai', 'faster-whisper', 'deepgram', 'openai'])
    .default('assemblyai'),
  ASSEMBLYAI_API_KEY: optStr,
  OLLAMA_ENABLED: bool(false),
  OLLAMA_BASE_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('llama3.2'),
  LOCAL_STT_ENABLED: bool(false),
  LOCAL_STT_URL: z.url().default('http://localhost:8000'),
  LOCAL_STT_MODEL: z.string().min(1).default('Systran/faster-whisper-small'),
  OPENAI_ENABLED: bool(false),
  OPENAI_API_KEY: optStr,
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  DEEPGRAM_ENABLED: bool(false),
  DEEPGRAM_API_KEY: optStr,
  AI_ALLOW_PAID_FALLBACK: bool(false),
  AI_REQUIRE_PROVIDER_APPROVAL: bool(true),
});
export type AIEnv = z.infer<typeof aiEnvSchema> & {
  /** Proposed default `assemblyai-stt-3-7`; Akash should confirm (sets STT cost). */
  ASSEMBLYAI_SPEECH_MODELS: AssemblyAiSpeechModel[];
};

export type ProviderAvailability = {
  provider: string;
  available: boolean;
  reason?: string | undefined;
};

export type LoadedAIEnv = { env: AIEnv; availability: ProviderAvailability[]; errors: string[] };

/**
 * Parse env without throwing on missing credentials. Invalid *shapes* (e.g. a malformed URL)
 * are reported in `errors` and fall back to defaults, so the process never crashes on boot.
 */
export function loadAIEnv(
  source: Record<string, string | undefined> = process.env,
  opts: { production?: boolean | undefined } = {},
): LoadedAIEnv {
  const production = opts.production ?? !isRelaxedNodeEnv(source.NODE_ENV);
  const errors: string[] = [];
  const parsed = aiEnvSchema.safeParse(source);
  let env: AIEnv;
  if (parsed.success) env = parsed.data as AIEnv;
  else if (production) {
    // Fail fast in production: never boot with silently-defaulted AI config. Messages name vars, never values.
    throw new Error(
      `Invalid AI env: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  } else {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join('.')}: invalid`);
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    const cleaned = Object.fromEntries(Object.entries(source).filter(([k]) => !bad.has(k)));
    env = aiEnvSchema.parse(cleaned) as AIEnv;
  }
  try {
    env.ASSEMBLYAI_SPEECH_MODELS = assemblyAiSpeechModelsFromEnv(source);
  } catch (e) {
    if (!(e instanceof InvalidAssemblyAiSpeechModelsError)) throw e;
    if (production) throw new Error('Invalid AI env: ASSEMBLYAI_SPEECH_MODELS');
    errors.push('ASSEMBLYAI_SPEECH_MODELS: invalid');
    env.ASSEMBLYAI_SPEECH_MODELS = [...DEFAULT_ASSEMBLYAI_SPEECH_MODELS];
  }
  const a = (provider: string, available: boolean, reason: string): ProviderAvailability =>
    available ? { provider, available } : { provider, available, reason };
  const availability: ProviderAvailability[] = [
    a('gemini', !!env.GEMINI_API_KEY, 'GEMINI_API_KEY is not set'),
    a('assemblyai', !!env.ASSEMBLYAI_API_KEY, 'ASSEMBLYAI_API_KEY is not set'),
    a('ollama', env.OLLAMA_ENABLED, 'OLLAMA_ENABLED is false'),
    a('faster-whisper', env.LOCAL_STT_ENABLED, 'LOCAL_STT_ENABLED is false'),
    a(
      'openai',
      env.OPENAI_ENABLED && !!env.OPENAI_API_KEY,
      env.OPENAI_ENABLED ? 'OPENAI_API_KEY is not set' : 'OPENAI_ENABLED is false',
    ),
    a(
      'deepgram',
      false,
      env.DEEPGRAM_ENABLED
        ? 'Deepgram adapter is a stub (not implemented yet)'
        : 'DEEPGRAM_ENABLED is false',
    ),
  ];
  return { env, availability, errors };
}
