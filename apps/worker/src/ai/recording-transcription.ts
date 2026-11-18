import { UnrecoverableError } from 'bullmq';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  hashSegments,
  mergeChunkTranscripts,
  type ChunkTranscript,
  type OnProviderTranscriptStored,
  type TranscriptRevision,
} from '@meetops/ai-core';
import { ProviderError, type ProviderErrorCode } from './providers/errors.js';
import type {
  TranscriptionAudio,
  TranscriptionProvider,
  TranscribeResult,
} from './providers/transcription-provider.js';
import {
  toRevisionWrite,
  type RecordingScope,
  type RecordingTranscriptRepository,
} from './repository.js';
import type { SummaryTrigger } from './summary-trigger.js';
import type { TranscriptionLogger } from './consumer.js';

const Uuid = Type.String({ format: 'uuid', pattern: '^[0-9a-fA-F-]{36}$' });
export const RecordingTranscriptionInput = Type.Object(
  {
    organizationId: Uuid,
    meetingId: Uuid,
    recordingId: Uuid,
    language: Type.Optional(Type.String({ pattern: '^[a-z]{2}(_[a-z]{2})?$' })),
  },
  { additionalProperties: false },
);
export type RecordingTranscriptionInput = {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  language?: string | undefined;
};

export type RecordingTranscriptionDeps = {
  provider: TranscriptionProvider;
  repository: RecordingTranscriptRepository;
  /** Returns a short-lived https URL (preferred) or bytes for the recording. Never logged. */
  resolveAudio: (recording: RecordingScope) => Promise<TranscriptionAudio>;
  logger: TranscriptionLogger;
  speakerLabels?: boolean | undefined;
  /** Enqueues the meeting summary once the transcript is `ready` (deduped by meeting + revision + prompt version). */
  summaryTrigger?: SummaryTrigger | undefined;
  /** After the chunk is durably stored, enqueue provider-side transcript delete (ADR-019). */
  onProviderTranscriptStored?: OnProviderTranscriptStored | undefined;
  now?: () => Date;
};

export type RecordingTranscriptionErrorCode =
  | 'invalid_payload'
  | 'meeting_not_found'
  | 'recording_not_found'
  | 'org_mismatch'
  | 'audio_unavailable'
  | 'revision_conflict'
  | 'summary_enqueue_failed'
  | 'provider_delete_enqueue_failed'
  | `provider_${ProviderErrorCode}`;

export class RecordingTranscriptionError extends Error {
  constructor(
    readonly code: RecordingTranscriptionErrorCode,
    readonly retryable: boolean,
  ) {
    super(`recording transcription failed: ${code}`);
    this.name = 'RecordingTranscriptionError';
  }
}

export type RecordingTranscriptionResult = {
  recordingId: string;
  revision: number;
  /** True when no new provider call or revision was needed (replay / retry after success). */
  duplicate: boolean;
  providerCalled: boolean;
};

/** Whole recording = chunk 0 of a 1-chunk recording, so it shares storage and merge logic with the chunk pipeline. */
export function toWholeRecordingChunk(r: TranscribeResult, receivedAt: string): ChunkTranscript {
  const durationSec = (r.durationMs ?? Math.max(0, ...r.segments.map((s) => s.endMs))) / 1000;
  return {
    chunkIndex: 0,
    startSec: 0,
    durationSec,
    overlapSec: 0,
    provider: r.provider,
    model: r.model,
    language: r.language ?? undefined,
    receivedAt,
    ...(r.providerJobId ? { providerJobId: r.providerJobId } : {}),
    segments: r.segments.map((s) => ({
      startSec: s.startMs / 1000,
      endSec: s.endMs / 1000,
      text: s.text,
      ...(s.speaker !== null ? { speaker: s.speaker } : {}),
      ...(s.confidence !== null ? { confidence: s.confidence } : {}),
    })),
  };
}

/**
 * Transcribe one whole recording and store it through the repository.
 * Idempotent and retry-safe:
 * - the raw provider result is stored first (chunk 0, first write wins), so a retry after a DB failure does not
 *   call the provider again;
 * - a revision is written with compare-and-set only when content changed;
 * - on a permanent provider error, or the last attempt, the anchor transcript is marked `failed`.
 * `isFinalAttempt` lets the BullMQ wrapper mark failure only when no retry follows.
 */
export async function processRecordingTranscription(
  input: RecordingTranscriptionInput,
  deps: RecordingTranscriptionDeps,
  ctx: { jobId?: string | undefined; isFinalAttempt?: boolean | undefined } = {},
): Promise<RecordingTranscriptionResult> {
  if (!Value.Check(RecordingTranscriptionInput, input))
    throw new RecordingTranscriptionError('invalid_payload', false);
  const { organizationId, meetingId, recordingId } = input;
  const log = { organizationId, meetingId, recordingId, jobId: ctx.jobId };
  const now = deps.now ?? (() => new Date());
  const repo = deps.repository;
  const fail = (code: RecordingTranscriptionErrorCode, retryable: boolean): never => {
    deps.logger.warn({ ...log, errorCode: code }, 'recording transcription rejected');
    throw new RecordingTranscriptionError(code, retryable);
  };

  const scope = await repo.withOrgContext(organizationId, async (r) => {
    const meeting = await r.findMeeting(meetingId);
    const recording = meeting ? await r.findRecording(recordingId) : undefined;
    const existing = recording ? await r.getChunkResult(meetingId, recordingId, 0) : undefined;
    return { meeting, recording, existing };
  });
  if (!scope.meeting) return fail('meeting_not_found', false);
  if (scope.meeting.organizationId !== organizationId) return fail('org_mismatch', false);
  const recording = scope.recording;
  if (!recording) return fail('recording_not_found', false);
  if (recording.organizationId !== organizationId || recording.meetingId !== meetingId)
    return fail('org_mismatch', false);

  let chunk = scope.existing;
  let providerCalled = false;
  let fresh: ChunkTranscript | undefined;
  if (!chunk) {
    let result: TranscribeResult;
    try {
      const audio = await deps.resolveAudio(recording).catch(() => {
        throw new RecordingTranscriptionError('audio_unavailable', true);
      });
      providerCalled = true;
      result = await deps.provider.transcribe({
        audio,
        language: input.language,
        speakerLabels: deps.speakerLabels ?? true,
      });
    } catch (err) {
      const e =
        err instanceof RecordingTranscriptionError
          ? err
          : err instanceof ProviderError
            ? new RecordingTranscriptionError(`provider_${err.code}`, err.retryable)
            : new RecordingTranscriptionError('provider_unavailable', true);
      deps.logger.warn(
        { ...log, provider: deps.provider.id, errorCode: e.code, retryable: e.retryable },
        'recording transcription attempt failed',
      );
      if (!e.retryable || ctx.isFinalAttempt) {
        await repo
          .withOrgContext(organizationId, (r) =>
            r.markTranscriptFailed(meetingId, recordingId, deps.provider.id),
          )
          .catch(() =>
            deps.logger.error({ ...log }, 'recording transcription failed-status write failed'),
          );
      }
      throw e;
    }
    fresh = toWholeRecordingChunk(result, now().toISOString());
    chunk = await repo.withOrgContext(organizationId, async (r) =>
      (await r.putChunkResult(meetingId, recordingId, fresh))
        ? fresh
        : ((await r.getChunkResult(meetingId, recordingId, 0)) ?? fresh),
    );
  }

  if (deps.onProviderTranscriptStored) {
    try {
      // First-write losers are not in the stored row; enqueue their id too, deduped.
      const ids = new Set<string>();
      if (chunk.providerJobId) ids.add(chunk.providerJobId);
      if (fresh?.providerJobId) ids.add(fresh.providerJobId);
      const hookIds: Array<string | undefined> = ids.size > 0 ? [...ids] : [undefined];
      for (const providerJobId of hookIds) {
        await deps.onProviderTranscriptStored({
          organizationId,
          meetingId,
          recordingId,
          chunkIndex: chunk.chunkIndex,
          provider: chunk.provider,
          ...(providerJobId ? { providerJobId } : {}),
        });
      }
    } catch {
      return fail('provider_delete_enqueue_failed', true);
    }
  }

  const merged = mergeChunkTranscripts([chunk], 1);
  const contentHash = hashSegments(merged.segments);
  for (let i = 0; i < 3; i++) {
    const out = await repo.withOrgContext(organizationId, async (r) => {
      const prev = await r.latestTranscript(meetingId, recordingId);
      if (prev && prev.contentHash === contentHash && prev.complete === merged.complete)
        return { revision: prev.revision, duplicate: true };
      const rev: TranscriptRevision = {
        ...merged,
        organizationId,
        meetingId,
        recordingId,
        revision: (prev?.revision ?? 0) + 1,
        contentHash,
        createdAt: now().toISOString(),
      };
      const ok = await r.writeTranscriptRevision(
        toRevisionWrite(rev, chunk.provider, chunk.language),
        prev?.revision ?? 0,
      );
      return ok ? { revision: rev.revision, duplicate: false } : undefined;
    });
    if (out) {
      // Also on duplicates: covers a crash between the transcript write and the enqueue (job id dedupes).
      if (merged.complete && deps.summaryTrigger) {
        try {
          await deps.summaryTrigger.transcriptReady({
            organizationId,
            meetingId,
            transcriptRevision: out.revision,
          });
        } catch {
          // Transcript is durable; retrying this job is cheap (duplicate path, no provider call) and re-enqueues.
          return fail('summary_enqueue_failed', true);
        }
      }
      deps.logger.info(
        { ...log, revision: out.revision, duplicate: out.duplicate && !providerCalled },
        'recording transcription done',
      );
      return {
        recordingId,
        revision: out.revision,
        duplicate: out.duplicate && !providerCalled,
        providerCalled,
      };
    }
  }
  return fail('revision_conflict', true);
}

/** BullMQ-shaped wrapper: final attempt is derived from attemptsMade/opts.attempts. */
export function createRecordingTranscriptionProcessor(deps: RecordingTranscriptionDeps) {
  return async (job: {
    id?: string | undefined;
    data: RecordingTranscriptionInput;
    attemptsMade?: number;
    opts?: { attempts?: number };
  }) => {
    try {
      return await processRecordingTranscription(job.data, deps, {
        jobId: job.id,
        isFinalAttempt: (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1),
      });
    } catch (err) {
      if (err instanceof RecordingTranscriptionError && !err.retryable)
        throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}
