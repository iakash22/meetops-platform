import { Value } from '@sinclair/typebox/value';
import {
  TranscriptionJobPayload as TranscriptionJobSchema,
  type TranscriptionJobPayload,
} from '@meetops/contracts';
import {
  InvalidTranscriptionJobError,
  TranscriptionChunkHandler,
  toChunkJob,
  transcriptionIdempotencyKey,
  type AIExecutor,
  type AttemptError,
  type AudioResolver,
  type ChunkGeometry,
} from '@meetops/ai-core';
import {
  TRANSCRIPTION_SYSTEM_ACTOR,
  type TranscriptionAuditEntry,
  type TranscriptionAuditSink,
} from './actor.js';
import {
  RepositoryTranscriptStore,
  type RecordingScope,
  type TranscriptRepository,
} from './repository.js';
import { chunkProgressEvent, type TranscriptionProgressSink } from './progress.js';
import type { SummaryTrigger } from './summary-trigger.js';

export type TranscriptionLogger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

/**
 * Credentials never appear here or in job payloads: `executor` is built from ai-core provider configs that hold
 * credential refs (`env:...` / secret refs) resolved inside ai-core.
 */
export type TranscriptionConsumerDeps = {
  executor: AIExecutor;
  repository: TranscriptRepository;
  resolveAudio: AudioResolver;
  realtime: TranscriptionProgressSink;
  audit: TranscriptionAuditSink;
  logger: TranscriptionLogger;
  geometry: ChunkGeometry;
  /** Enqueues the meeting summary once the merged transcript is complete (`ready`). Deduped by job id. */
  summaryTrigger?: SummaryTrigger | undefined;
  now?: () => Date;
};

export type TranscriptionErrorCode =
  | 'invalid_payload'
  | 'idempotency_key_mismatch'
  | 'meeting_not_found'
  | 'recording_not_found'
  | 'org_mismatch'
  | 'provider_failed'
  | 'provider_retryable'
  | 'provider_waiting'
  | 'summary_enqueue_failed';

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
 * Process one `transcribe_recording` job from QUEUE_NAMES.transcription as the system actor `worker:transcription`
 * for the job's organizationId:
 * contract check -> meeting.organizationId === job.organizationId (first DB access) -> recording belongs to meeting ->
 * idempotency key `transcribe:{recordingId}:{index}` -> ai-core TranscriptionChunkHandler (transcriptionJobToRequest +
 * AIExecutor, default routing; the system actor never overrides providers) -> repository writes -> audit -> progress.
 */
export async function processTranscriptionJob(
  data: TranscriptionJobPayload,
  deps: TranscriptionConsumerDeps,
  ctx: { jobId?: string | undefined } = {},
): Promise<TranscriptionJobResult> {
  if (!Value.Check(TranscriptionJobSchema, data))
    throw new TranscriptionJobError('invalid_payload', false);
  const { organizationId, meetingId, recordingId } = data;
  const log = {
    actorId: TRANSCRIPTION_SYSTEM_ACTOR.id,
    organizationId,
    meetingId,
    recordingId,
    chunkIndex: data.chunkIndex,
    jobId: ctx.jobId,
  };
  const now = deps.now ?? (() => new Date());
  const audit = async (
    e: Pick<TranscriptionAuditEntry, 'outcome' | 'errorCode' | 'provider' | 'revision'>,
  ) => {
    try {
      await deps.audit.record({
        actor: TRANSCRIPTION_SYSTEM_ACTOR,
        organizationId,
        action: 'transcription.chunk',
        meetingId,
        recordingId,
        chunkIndex: data.chunkIndex,
        jobId: ctx.jobId,
        at: now().toISOString(),
        ...e,
      });
    } catch {
      deps.logger.warn({ ...log }, 'transcription audit write failed');
    }
  };
  const reject = async (
    code: TranscriptionErrorCode,
    level: 'warn' | 'error' = 'warn',
  ): Promise<never> => {
    deps.logger[level]({ ...log, errorCode: code }, 'transcription job rejected');
    await audit({ outcome: 'rejected', errorCode: code });
    throw new TranscriptionJobError(code, false);
  };

  // Tenant check before anything else. Under RLS a foreign meeting is invisible -> meeting_not_found.
  const scope = await deps.repository.withOrgContext(organizationId, async (repo) => {
    const meeting = await repo.findMeeting(meetingId);
    const recording = meeting ? await repo.findRecording(recordingId) : undefined;
    return { meeting, recording };
  });
  if (!scope.meeting) return reject('meeting_not_found');
  if (scope.meeting.organizationId !== organizationId) return reject('org_mismatch', 'error');
  const recording: RecordingScope | undefined = scope.recording;
  if (!recording) return reject('recording_not_found');
  if (recording.organizationId !== organizationId || recording.meetingId !== meetingId)
    return reject('org_mismatch', 'error');

  if (
    data.chunkIndex === undefined ||
    data.idempotencyKey !== transcriptionIdempotencyKey(recordingId, data.chunkIndex)
  ) {
    return reject('idempotency_key_mismatch');
  }
  let chunkJob;
  try {
    chunkJob = toChunkJob(data, ctx.jobId, deps.geometry);
  } catch (err) {
    if (err instanceof InvalidTranscriptionJobError) return reject('invalid_payload');
    throw err;
  }
  if (recording.chunkCount !== undefined) chunkJob.chunk.count = recording.chunkCount;

  const handler = new TranscriptionChunkHandler({
    executor: deps.executor,
    store: new RepositoryTranscriptStore(deps.repository),
    resolveAudio: deps.resolveAudio,
    // System actor: no TenantContext/ability, so the payload's sttProviderId is not an override; org/env routing applies.
    resolveActor: async () => undefined,
    now,
  });
  const out = await handler.handle(chunkJob);

  if (out.status !== 'succeeded') {
    // Provider-level codes only (AttemptError has no messages/keys).
    const errors = out.errors.map((e) => `${e.provider}:${e.code}`);
    const code: TranscriptionErrorCode =
      out.status === 'failed'
        ? 'provider_failed'
        : out.status === 'waiting'
          ? 'provider_waiting'
          : 'provider_retryable';
    deps.logger.warn({ ...log, errorCode: code, errors }, 'transcription attempt failed');
    await audit({ outcome: 'failed', errorCode: code, provider: out.errors[0]?.provider });
    throw new TranscriptionJobError(code, out.status !== 'failed', out.errors);
  }

  const chunks = await deps.repository.withOrgContext(organizationId, (repo) =>
    repo.listChunkResults(meetingId, recordingId),
  );
  // Also on duplicates: covers a crash between the revision write and the enqueue. The job id dedupes.
  if (out.revision?.complete === true && deps.summaryTrigger) {
    try {
      await deps.summaryTrigger.transcriptReady({
        organizationId,
        meetingId,
        transcriptRevision: out.revision.revision,
      });
    } catch {
      deps.logger.warn({ ...log, errorCode: 'summary_enqueue_failed' }, 'summary enqueue failed');
      throw new TranscriptionJobError('summary_enqueue_failed', true);
    }
  }
  const provider = chunks.find((c) => c.chunkIndex === chunkJob.chunk.index)?.provider;
  await audit({
    outcome: out.duplicate ? 'duplicate' : 'succeeded',
    provider,
    revision: out.revision?.revision,
  });
  try {
    deps.realtime.transcriptionProgress(
      chunkProgressEvent({
        organizationId,
        meetingId,
        recordingId,
        chunksDone: chunks.length,
        chunksTotal: recording.chunkCount,
        complete: out.revision?.complete === true && recording.chunkCount !== undefined,
        at: now(),
      }),
    );
  } catch {
    // Realtime is best-effort; the transcript is already durable.
    deps.logger.warn({ ...log }, 'transcription progress publish failed');
  }

  deps.logger.info(
    { ...log, duplicate: out.duplicate, revision: out.revision?.revision },
    'transcription chunk done',
  );
  return {
    recordingId,
    chunkIndex: chunkJob.chunk.index,
    duplicate: out.duplicate,
    revision: out.revision?.revision,
    revisionChanged: out.revisionChanged,
  };
}
