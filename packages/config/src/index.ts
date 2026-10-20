import { z } from 'zod';

const bool = z
  .string()
  .transform((s) => s.toLowerCase())
  .refine((s) => ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''].includes(s), {
    message: 'Invalid boolean string'
  })
  .transform((s) => ['true', '1', 'yes', 'on'].includes(s));

const numberFromString = z
  .string()
  .regex(/^-?\\d+$/, 'Must be an integer string')
  .transform((s) => parseInt(s, 10));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Database
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/meetops'),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Storage
  STORAGE_PROVIDER: z.enum(['minio', 'r2', 's3']).default('minio'),
  STORAGE_ENDPOINT: z.string().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('meetops-dev'),
  STORAGE_ACCESS_KEY_ID: z.string().default('minioadmin'),
  STORAGE_SECRET_ACCESS_KEY: z.string().default('minioadmin'),
  STORAGE_FORCE_PATH_STYLE: bool.default('true'),

  // Email
  EMAIL_PROVIDER: z.enum(['smtp']).default('smtp'),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: numberFromString.default('465'),
  SMTP_SECURE: bool.default('true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  EMAIL_FROM: z.string().default('noreply@example.com'),

  // AI providers
  AI_LLM_PROVIDER: z.enum(['gemini']).default('gemini'),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),
  GEMINI_API_KEY: z.string().default(''),
  AI_STT_PROVIDER: z.enum(['assemblyai']).default('assemblyai'),
  ASSEMBLYAI_API_KEY: z.string().default(''),
  OLLAMA_ENABLED: bool.default('false'),
  OLLAMA_BASE_URL: z.string().default('http://localhost:11434'),
  LOCAL_STT_ENABLED: bool.default('false'),
  LOCAL_STT_URL: z.string().default('http://localhost:8001'),
  OPENAI_ENABLED: bool.default('false'),
  OPENAI_API_KEY: z.string().default(''),
  DEEPGRAM_ENABLED: bool.default('false'),
  DEEPGRAM_API_KEY: z.string().default(''),
  AI_ALLOW_PAID_FALLBACK: bool.default('false'),
  AI_REQUIRE_PROVIDER_APPROVAL: bool.default('true')
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Throw without logging secrets
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }
  return result.data;
}
