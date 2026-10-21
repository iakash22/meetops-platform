import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v)));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const aiEnvSchema = z.object({
  AI_LLM_PROVIDER: z.enum(['gemini', 'ollama', 'openai']).default('gemini'),
  GEMINI_MODEL: z.string().min(1).default('gemini-2.5-flash-lite'),
  GEMINI_API_KEY: optStr,
  AI_STT_PROVIDER: z.enum(['assemblyai', 'faster-whisper', 'deepgram', 'openai']).default('assemblyai'),
  ASSEMBLYAI_API_KEY: optStr,
  OLLAMA_ENABLED: bool(false),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('llama3.2'),
  LOCAL_STT_ENABLED: bool(false),
  LOCAL_STT_URL: z.string().url().default('http://localhost:8000'),
  LOCAL_STT_MODEL: z.string().min(1).default('Systran/faster-whisper-small'),
  OPENAI_ENABLED: bool(false),
  OPENAI_API_KEY: optStr,
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  DEEPGRAM_ENABLED: bool(false),
  DEEPGRAM_API_KEY: optStr,
  AI_ALLOW_PAID_FALLBACK: bool(false),
  AI_REQUIRE_PROVIDER_APPROVAL: bool(true),
});
export type AIEnv = z.infer<typeof aiEnvSchema>;

export type ProviderAvailability = { provider: string; available: boolean; reason?: string | undefined };

export type LoadedAIEnv = { env: AIEnv; availability: ProviderAvailability[]; errors: string[] };

/**
 * Parse env without throwing on missing credentials. Invalid *shapes* (e.g. a malformed URL)
 * are reported in `errors` and fall back to defaults, so the process never crashes on boot.
 */
export function loadAIEnv(source: Record<string, string | undefined> = process.env): LoadedAIEnv {
  const errors: string[] = [];
  const parsed = aiEnvSchema.safeParse(source);
  let env: AIEnv;
  if (parsed.success) env = parsed.data;
  else {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join('.')}: ${issue.message}`);
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    const cleaned = Object.fromEntries(Object.entries(source).filter(([k]) => !bad.has(k)));
    env = aiEnvSchema.parse(cleaned);
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
    a('deepgram', false, env.DEEPGRAM_ENABLED ? 'Deepgram adapter is a stub (not implemented yet)' : 'DEEPGRAM_ENABLED is false'),
  ];
  return { env, availability, errors };
}
