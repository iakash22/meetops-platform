import { z } from 'zod';

const bool = z
  .string()
  .transform((s) => s.toLowerCase())
  .refine((s) => ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''].includes(s), {
    error: 'Invalid boolean string',
  })
  .transform((s) => ['true', '1', 'yes', 'on'].includes(s));

/**
 * Boolean env var with an explicit boolean default.
 *
 * zod 4's `.default()` short-circuits: when the key is unset it returns the default as-is,
 * without running the string->boolean transform. `bool.default('false')` would therefore
 * yield the truthy string `'false'`. Always pass a real boolean here (see
 * docs/plans/zod4-migration.md, change 1). Set values ('false', '0', 'no', ...) still go
 * through `bool`.
 */
const boolEnv = (def: boolean) => bool.default(def);

const numberFromString = z.coerce.number().int().nonnegative();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database
  DATABASE_URL: z.url().default('postgresql://postgres:postgres@localhost:5432/meetops'),

  // Redis
  REDIS_URL: z.url().default('redis://localhost:6379'),

  // Storage
  STORAGE_PROVIDER: z.enum(['minio', 'r2', 's3']).default('minio'),
  STORAGE_ENDPOINT: z.string().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('meetops-dev'),
  STORAGE_ACCESS_KEY_ID: z.string().default('minioadmin'),
  STORAGE_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  STORAGE_FORCE_PATH_STYLE: boolEnv(true),

  // Email
  EMAIL_PROVIDER: z.enum(['smtp']).default('smtp'),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: numberFromString.default(465),
  SMTP_SECURE: boolEnv(true),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  EMAIL_FROM: z.string().default('noreply@example.com'),

  // AI providers.
  // @deprecated: packages/ai-core owns the AI_* and provider-toggle keys and reads them via
  // `loadAIEnv` (aiEnvSchema). These copies are kept only so `AppConfig` keeps its shape for
  // existing consumers; nothing reads them from AppConfig. Do not add new readers here. See
  // docs/plans/zod4-migration.md (step 3).
  /** @deprecated Read `AI_LLM_PROVIDER` from `loadAIEnv()` in `@meetops/ai-core`. */
  AI_LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  /** @deprecated Read `GEMINI_MODEL` from `loadAIEnv()` in `@meetops/ai-core`. */
  GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),
  /** @deprecated Read `GEMINI_API_KEY` from `loadAIEnv()` in `@meetops/ai-core`. */
  GEMINI_API_KEY: z.string().default(''),
  /** @deprecated Read `AI_STT_PROVIDER` from `loadAIEnv()` in `@meetops/ai-core`. */
  AI_STT_PROVIDER: z.enum(['assemblyai']).default('assemblyai'),
  /** @deprecated Read `ASSEMBLYAI_API_KEY` from `loadAIEnv()` in `@meetops/ai-core`. */
  ASSEMBLYAI_API_KEY: z.string().default(''),
  /** @deprecated Read `OLLAMA_ENABLED` from `loadAIEnv()` in `@meetops/ai-core`. */
  OLLAMA_ENABLED: boolEnv(false),
  /** @deprecated Read `OLLAMA_BASE_URL` from `loadAIEnv()` in `@meetops/ai-core`. */
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  /** @deprecated Read `LOCAL_STT_ENABLED` from `loadAIEnv()` in `@meetops/ai-core`. */
  LOCAL_STT_ENABLED: boolEnv(false),
  /** @deprecated Read `LOCAL_STT_URL` from `loadAIEnv()` in `@meetops/ai-core`. */
  LOCAL_STT_URL: z.string().default('http://localhost:8001'),
  /** @deprecated Read `OPENAI_ENABLED` from `loadAIEnv()` in `@meetops/ai-core`. */
  OPENAI_ENABLED: boolEnv(false),
  /** @deprecated Read `OPENAI_API_KEY` from `loadAIEnv()` in `@meetops/ai-core`. */
  OPENAI_API_KEY: z.string().default(''),
  /** @deprecated Read `DEEPGRAM_ENABLED` from `loadAIEnv()` in `@meetops/ai-core`. */
  DEEPGRAM_ENABLED: boolEnv(false),
  /** @deprecated Read `DEEPGRAM_API_KEY` from `loadAIEnv()` in `@meetops/ai-core`. */
  DEEPGRAM_API_KEY: z.string().default(''),
  /** @deprecated Read `AI_ALLOW_PAID_FALLBACK` from `loadAIEnv()` in `@meetops/ai-core`. */
  AI_ALLOW_PAID_FALLBACK: boolEnv(false),
  /** @deprecated Read `AI_REQUIRE_PROVIDER_APPROVAL` from `loadAIEnv()` in `@meetops/ai-core`. */
  AI_REQUIRE_PROVIDER_APPROVAL: boolEnv(true),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Throw without logging secrets: zod 4 issues never include the input value
    // (reportInput is off), and prettifyError only prints the message and path.
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
