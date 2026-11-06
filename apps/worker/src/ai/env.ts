import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DEFAULT_TRANSCRIPTION_RETRY,
  type TranscriptionRetryPolicy,
} from './transcription-retry.js';

const BoolString = Type.Union(
  ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''].map((v) => Type.Literal(v)),
);
const IntString = Type.String({ pattern: '^[0-9]{1,5}$' });

/** Worker env schema for the AI transcription consumer. Unknown keys are ignored; invalid values fail startup. */
export const TranscriptionWorkerEnvSchema = Type.Object({
  TRANSCRIPTION_WORKER_ENABLED: Type.Optional(BoolString),
  TRANSCRIPTION_WORKER_CONCURRENCY: Type.Optional(IntString),
  MEDIA_CHUNK_SECONDS: Type.Optional(IntString),
  REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
  TRANSCRIPTION_MAX_ATTEMPTS: Type.Optional(IntString),
  TRANSCRIPTION_BACKOFF_BASE_MS: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' })),
  TRANSCRIPTION_BACKOFF_MAX_MS: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' })),
});

export type TranscriptionWorkerEnv = {
  enabled: boolean;
  concurrency: number;
  segmentSeconds: number;
  redisUrl: string;
  retry: TranscriptionRetryPolicy;
};

export class TranscriptionWorkerEnvError extends Error {}

export function loadTranscriptionWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionWorkerEnv {
  const raw = {
    TRANSCRIPTION_WORKER_ENABLED: env.TRANSCRIPTION_WORKER_ENABLED?.toLowerCase(),
    TRANSCRIPTION_WORKER_CONCURRENCY: env.TRANSCRIPTION_WORKER_CONCURRENCY,
    MEDIA_CHUNK_SECONDS: env.MEDIA_CHUNK_SECONDS,
    REDIS_URL: env.REDIS_URL,
    TRANSCRIPTION_MAX_ATTEMPTS: env.TRANSCRIPTION_MAX_ATTEMPTS,
    TRANSCRIPTION_BACKOFF_BASE_MS: env.TRANSCRIPTION_BACKOFF_BASE_MS,
    TRANSCRIPTION_BACKOFF_MAX_MS: env.TRANSCRIPTION_BACKOFF_MAX_MS,
  };
  const clean = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  ) as Static<typeof TranscriptionWorkerEnvSchema>;
  if (!Value.Check(TranscriptionWorkerEnvSchema, clean)) {
    // Report key names only, never values.
    const keys = [
      ...new Set(
        [...Value.Errors(TranscriptionWorkerEnvSchema, clean)].map((e) =>
          e.path.replace(/^\//, ''),
        ),
      ),
    ];
    throw new TranscriptionWorkerEnvError(`Invalid transcription worker env: ${keys.join(', ')}`);
  }
  const int = (v: string | undefined, def: number, min: number, max: number, name: string) => {
    const n = v ? Number(v) : def;
    if (n < min || n > max)
      throw new TranscriptionWorkerEnvError(`${name} must be in ${min}..${max}`);
    return n;
  };
  return {
    enabled: ['true', '1', 'yes', 'on'].includes(clean.TRANSCRIPTION_WORKER_ENABLED ?? 'false'),
    concurrency: int(
      clean.TRANSCRIPTION_WORKER_CONCURRENCY,
      1,
      1,
      16,
      'TRANSCRIPTION_WORKER_CONCURRENCY',
    ),
    segmentSeconds: int(clean.MEDIA_CHUNK_SECONDS, 600, 10, 3600, 'MEDIA_CHUNK_SECONDS'),
    redisUrl: clean.REDIS_URL ?? 'redis://localhost:6379',
    retry: loadRetry(clean, int),
  };
}

function loadRetry(
  clean: Static<typeof TranscriptionWorkerEnvSchema>,
  int: (v: string | undefined, def: number, min: number, max: number, name: string) => number,
): TranscriptionRetryPolicy {
  const d = DEFAULT_TRANSCRIPTION_RETRY;
  const baseDelayMs = int(
    clean.TRANSCRIPTION_BACKOFF_BASE_MS,
    d.baseDelayMs,
    100,
    3_600_000,
    'TRANSCRIPTION_BACKOFF_BASE_MS',
  );
  const maxDelayMs = int(
    clean.TRANSCRIPTION_BACKOFF_MAX_MS,
    d.maxDelayMs,
    1_000,
    6 * 3_600_000,
    'TRANSCRIPTION_BACKOFF_MAX_MS',
  );
  if (maxDelayMs < baseDelayMs)
    throw new TranscriptionWorkerEnvError(
      'TRANSCRIPTION_BACKOFF_MAX_MS must be >= TRANSCRIPTION_BACKOFF_BASE_MS',
    );
  return {
    attempts: int(
      clean.TRANSCRIPTION_MAX_ATTEMPTS,
      d.attempts,
      1,
      20,
      'TRANSCRIPTION_MAX_ATTEMPTS',
    ),
    baseDelayMs,
    maxDelayMs,
  };
}
