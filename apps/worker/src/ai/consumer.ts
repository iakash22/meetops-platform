import { Value } from '@sinclair/typebox/value';
import { TranscriptionJobPayload as TranscriptionJobSchema, type TranscriptionJobPayload } from '@meetops/contracts';
import {
  InvalidTranscriptionJobError,
  TranscriptionChunkHandler,
  toChunkJob,
  transcriptionIdempotencyKey,
  type AIExecutor,
  type AttemptError,
  type AudioResolver,
  type ChunkGeometry,
  type JobActorResolver,
} from '@meetops/ai-core';
import { RepositoryTranscriptStore, type TranscriptRepository } from './repository.js';
import { chunkProgressEvent, type TranscriptionProgressSink } from './progress.js';

export type TranscriptionLogger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type TranscriptionConsumerDeps = {
  executor: AIExecutor;
  repository: TranscriptRepository;
  resolveAudio: AudioResolver;
  resolveActor: JobActorResolver;
  realtime: TranscriptionProgressSink;
  logger: TranscriptionLogger;
  geometry: ChunkGeometry;
  now?: () => Date;
};

export type TranscriptionErrorCode =
  | 'invalid_payload'
  | 'idempotency_key_mismatch'
  | 'recording_not_found'
  | 'org_mismatch'
  | 'provider_failed'
  | 'provider_retryable'
  | 'provider_waiting';

/** `retryable=false` maps to BullMQ `UnrecoverableError` in worker.ts (no further attempts). Messages carry no secrets. */
export class TranscriptionJobError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    readonly retryable: boolean,
    readonly attempts: AttemptError[] = [],
  ) {
    super(`transcription job failed: ${code}`);
    this.name = 'TranscriptionJobError';
  }
}

export type TranscriptionJobResult = {
  recordingId: string;
  chunkIndex: number;
  duplicate: boolean;
  revision: number | undefined;
  revisionChanged: boolean;
};

/**
 * Process one `transcribe_recording` job from QUEUE_NAMES.transcription:
 * contract check -> idempotency key `transcribe:{recordingId}:{index}` -> org-scoped recording lookup ->
 * ai-core TranscriptionChunkHandler (transcriptionJobToRequest + AIExecutor) -> repository writes -> progress event.
 */
export async function processTranscriptionJob(
  data: TranscriptionJobPayload,
  deps: TranscriptionConsumerDeps,
  ctx: { jobId?: string | undefined } = {},
): Promise<TranscriptionJobResult> {
  if (!Value.Check(TranscriptionJobSchema, data)) throw new TranscriptionJobError('invalid_payload', false);
  const { organizationId, meetingId, recordingId } = data;
  const log = { organizationId, meetingId, recordingId, chunkIndex: data.chunkIndex, jobId: ctx.jobId };
  const now = deps.now ?? (() => new Date());

  if (data.chunkIndex === undefined || data.idempotencyKey !== transcriptionIdempotencyKey(recordingId, data.chunkIndex)) {
    deps.logger.warn({ ...log, errorCode: 'idempotency_key_mismatch' }, 'transcription job rejected');
    throw new TranscriptionJobError('idempotency_key_mismatch', false);
  }

  let chunkJob;
  try {
    chunkJob = toChunkJob(data, ctx.jobId, deps.geometry);
  } catch (err) {
    if (err instanceof InvalidTranscriptionJobError) {
      deps.logger.warn({ ...log, errorCode: 'invalid_payload' }, 'transcription job rejected');
      throw new TranscriptionJobError('invalid_payload', false);
    }
    throw err;
  }

  const recording = await deps.repository.findRecording(organizationId, recordingId);
  if (!recording) {
    deps.logger.warn({ ...log, errorCode: 'recording_not_found' }, 'transcription job rejected');
    throw new TranscriptionJobError('recording_not_found', false);
  }
  if (recording.organizationId !== organizationId || recording.meetingId !== meetingId) {
    deps.logger.error({ ...log, errorCode: 'org_mismatch' }, 'transcription job rejected');
    throw new TranscriptionJobError('org_mismatch', false);
  }
  if (recording.chunkCount !== undefined) chunkJob.chunk.count = recording.chunkCount;

  const handler = new TranscriptionChunkHandler({
    executor: deps.executor,
    store: new RepositoryTranscriptStore(deps.repository),
    resolveAudio: deps.resolveAudio,
    resolveActor: deps.resolveActor,
    now,
  });
  const out = await handler.handle(chunkJob);

  if (out.status !== 'succeeded') {
    // Provider-level codes only (AttemptError has no messages/keys).
    const errors = out.errors.map((e) => `${e.provider}:${e.code}`);
    const code: TranscriptionErrorCode =
      out.status === 'failed' ? 'provider_failed' : out.status === 'waiting' ? 'provider_waiting' : 'provider_retryable';
    deps.logger.warn({ ...log, errorCode: code, errors }, 'transcription attempt failed');
    throw new TranscriptionJobError(code, out.status !== 'failed', out.errors);
  }

  const chunksDone = (await deps.repository.listChunkResults(organizationId, meetingId, recordingId)).length;
  try {
    deps.realtime.transcriptionProgress(
      chunkProgressEvent({
        organizationId,
        meetingId,
        recordingId,
        chunksDone,
        chunksTotal: recording.chunkCount,
        complete: out.revision?.complete === true && recording.chunkCount !== undefined,
        at: now(),
      }),
    );
  } catch {
    // Realtime is best-effort; the transcript is already durable.
    deps.logger.warn({ ...log }, 'transcription progress publish failed');
  }

  deps.logger.info({ ...log, duplicate: out.duplicate, revision: out.revision?.revision }, 'transcription chunk done');
  return {
    recordingId,
    chunkIndex: chunkJob.chunk.index,
    duplicate: out.duplicate,
    revision: out.revision?.revision,
    revisionChanged: out.revisionChanged,
  };
}
