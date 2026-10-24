import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const BoolString = Type.Union(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''].map((v) => Type.Literal(v)));
const IntString = Type.String({ pattern: '^[0-9]{1,5}$' });

/** Worker env schema for the AI transcription consumer. Unknown keys are ignored; invalid values fail startup. */
export const TranscriptionWorkerEnvSchema = Type.Object({
  TRANSCRIPTION_WORKER_ENABLED: Type.Optional(BoolString),
  TRANSCRIPTION_WORKER_CONCURRENCY: Type.Optional(IntString),
  MEDIA_CHUNK_SECONDS: Type.Optional(IntString),
  REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
});

export type TranscriptionWorkerEnv = {
  enabled: boolean;
  concurrency: number;
  segmentSeconds: number;
  redisUrl: string;
};

export class TranscriptionWorkerEnvError extends Error {}

export function loadTranscriptionWorkerEnv(env: NodeJS.ProcessEnv = process.env): TranscriptionWorkerEnv {
  const raw = {
    TRANSCRIPTION_WORKER_ENABLED: env.TRANSCRIPTION_WORKER_ENABLED?.toLowerCase(),
    TRANSCRIPTION_WORKER_CONCURRENCY: env.TRANSCRIPTION_WORKER_CONCURRENCY,
    MEDIA_CHUNK_SECONDS: env.MEDIA_CHUNK_SECONDS,
    REDIS_URL: env.REDIS_URL,
  };
  const clean = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) as Static<typeof TranscriptionWorkerEnvSchema>;
  if (!Value.Check(TranscriptionWorkerEnvSchema, clean)) {
    // Report key names only, never values.
    const keys = [...new Set([...Value.Errors(TranscriptionWorkerEnvSchema, clean)].map((e) => e.path.replace(/^\//, '')))];
    throw new TranscriptionWorkerEnvError(`Invalid transcription worker env: ${keys.join(', ')}`);
  }
  const int = (v: string | undefined, def: number, min: number, max: number, name: string) => {
    const n = v ? Number(v) : def;
    if (n < min || n > max) throw new TranscriptionWorkerEnvError(`${name} must be in ${min}..${max}`);
    return n;
  };
  return {
    enabled: ['true', '1', 'yes', 'on'].includes(clean.TRANSCRIPTION_WORKER_ENABLED ?? 'false'),
    concurrency: int(clean.TRANSCRIPTION_WORKER_CONCURRENCY, 1, 1, 16, 'TRANSCRIPTION_WORKER_CONCURRENCY'),
    segmentSeconds: int(clean.MEDIA_CHUNK_SECONDS, 600, 10, 3600, 'MEDIA_CHUNK_SECONDS'),
    redisUrl: clean.REDIS_URL ?? 'redis://localhost:6379',
  };
}
