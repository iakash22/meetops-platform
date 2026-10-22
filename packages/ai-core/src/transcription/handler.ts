import { createHash } from 'node:crypto';
import type { AIExecutor, AttemptError, JobStatus } from '../executor.js';
import type { TranscriptionInput, TranscriptionProvider } from '../types.js';
import type { TenantContext } from '../auth.js';
import { transcriptionJobToRequest, type TranscriptionJobPayload } from '../contracts.js';
import { mergeChunkTranscripts, type ChunkTranscript } from './merge.js';
import type { TranscriptRevision, TranscriptStore } from './store.js';

/**
 * Per-chunk STT job: contracts `TranscriptionJobPayload` plus the resolved chunk geometry (see transcription/queue.ts,
 * which derives it from contracts `chunkIndex`/`startMs`).
 */
export type TranscriptionChunkJobPayload = TranscriptionJobPayload & {
  chunk: {
    index: number;
    /** Total chunks for the recording if known (enables `complete`). */
    count?: number | undefined;
    startSec: number;
    durationSec: number;
    overlapSec: number;
    /** Storage object id for this chunk's audio (may differ from fileObjectId of the full recording). */
    fileObjectId: string;
  };
};

/**
 * Reads a chunk's audio server-side (tenant-checked) and returns BYTES. Owned by Media/Storage.
 * Bytes, not URLs: the AssemblyAI adapter uploads bytes so providers never fetch our storage URLs.
 */
export type AudioResolver = (q: { tenantId: string; fileObjectId: string }) => Promise<Pick<TranscriptionInput, 'bytes' | 'mimeType'>>;

/**
 * Server-derived actor for a job (e.g. the worker's service identity scoped to the org, or the enqueuing user's context
 * re-validated by Backend). Its ability decides whether the payload's provider choice may override routing.
 * Never derived from the payload itself.
 */
export type JobActorResolver = (q: { tenantId: string; requestId?: string | undefined }) => Promise<TenantContext | undefined>;

export type ChunkJobResult =
  | { status: 'succeeded'; duplicate: boolean; revision: TranscriptRevision | undefined; revisionChanged: boolean }
  | { status: Exclude<JobStatus, 'succeeded'>; errors: AttemptError[] };

export const STT_PROMPT_VERSION = 'stt@1';

export const chunkIdempotencyKey = (p: TranscriptionChunkJobPayload) =>
  `stt:${p.organizationId}:${p.meetingId}:${p.recordingId}:chunk:${p.chunk.index}`;

export function hashSegments(segs: Array<{ id: string; startSec: number; endSec: number; text: string; speaker?: string | undefined }>) {
  const h = createHash('sha256');
  for (const s of segs) h.update(`${s.id}|${s.startSec}|${s.endSec}|${s.speaker ?? ''}|${s.text}\n`);
  return h.digest('hex');
}

export class TranscriptionChunkHandler {
  constructor(
    private readonly deps: { executor: AIExecutor; store: TranscriptStore; resolveAudio: AudioResolver; resolveActor: JobActorResolver; now?: () => Date; maxCasRetries?: number },
  ) {}

  async handle(p: TranscriptionChunkJobPayload): Promise<ChunkJobResult> {
    const { organizationId: t, meetingId: m, recordingId: r } = p;
    const existing = await this.deps.store.getChunk(t, m, r, p.chunk.index);
    let duplicate = existing !== undefined;

    if (!existing) {
      const base = transcriptionJobToRequest(p);
      const actor = await this.deps.resolveActor({ tenantId: t, requestId: p.requestId });
      const audio = await this.deps.resolveAudio({ tenantId: t, fileObjectId: p.chunk.fileObjectId });
      const out = await this.deps.executor.run(
        // Without an authorized actor the payload's provider is ignored and normal routing applies (no override).
        {
          ...base,
          override: actor ? base.override : undefined,
          actor,
          idempotencyKey: chunkIdempotencyKey(p),
          promptVersion: STT_PROMPT_VERSION,
          jobId: p.requestId,
          requestId: p.requestId,
        },
        async (provider, ctx) => {
          const res = await (provider as TranscriptionProvider).transcribe({
            ...audio,
            language: p.languageHint,
            diarize: p.diarize,
            signal: ctx.signal,
          });
          return { value: res, usage: { audioSeconds: res.durationSec ?? p.chunk.durationSec } };
        },
      );
      if (out.status !== 'succeeded') return { status: out.status, errors: out.errors };
      const chunk: ChunkTranscript = {
        chunkIndex: p.chunk.index,
        startSec: p.chunk.startSec,
        durationSec: p.chunk.durationSec,
        overlapSec: p.chunk.index === 0 ? 0 : p.chunk.overlapSec,
        segments: out.value.segments.length
          ? out.value.segments
          : out.value.text
            ? [{ startSec: 0, endSec: p.chunk.durationSec, text: out.value.text }]
            : [],
        provider: out.meta.provider,
        model: out.meta.model,
        language: out.value.language,
        receivedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      };
      duplicate = !(await this.deps.store.putChunk(t, m, r, chunk));
    }

    // (Re)merge and write a new revision only if content changed. CAS loop guards concurrent chunk completions.
    for (let i = 0; i < (this.deps.maxCasRetries ?? 5); i++) {
      const prev = await this.deps.store.latestRevision(t, m, r);
      const merged = mergeChunkTranscripts(await this.deps.store.listChunks(t, m, r), p.chunk.count);
      const contentHash = hashSegments(merged.segments);
      if (prev && prev.contentHash === contentHash && prev.complete === merged.complete)
        return { status: 'succeeded', duplicate, revision: prev, revisionChanged: false };
      const rev: TranscriptRevision = {
        ...merged,
        tenantId: t,
        meetingId: m,
        recordingId: r,
        revision: (prev?.revision ?? 0) + 1,
        contentHash,
        createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      };
      if (await this.deps.store.putRevision(rev, prev?.revision ?? 0)) return { status: 'succeeded', duplicate, revision: rev, revisionChanged: true };
    }
    return { status: 'retryable', errors: [{ provider: '-', code: 'UNKNOWN' }] };
  }
}
