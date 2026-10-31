import { createHash } from 'node:crypto';
import { EMBEDDING_MAX_BATCH, type EmbedBatchResult } from '@meetops/ai-core';

/**
 * Phase 7 semantic search, PR 2: embeds a meeting's current transcript segments and summaries into
 * meeting_embeddings. Off by default (SEMANTIC_EMBEDDINGS_ENABLED) and, even when on, nothing is embedded until an
 * approved provider is routed for the ai-core `embeddings` feature (no default provider has the capability).
 * Content is hashed: a source whose text did not change since it was embedded is skipped. Only ids, counts and
 * error codes are logged, never meeting text.
 */

export const EMBEDDINGS_QUEUE = 'meeting-embeddings';
export const EMBEDDINGS_JOB_NAME = 'embed-meeting';

export type EmbeddingSourceKind = 'transcript_segment' | 'summary';
export type EmbeddingSource = { kind: EmbeddingSourceKind; id: string; text: string };
export type EmbeddingRow = {
  kind: EmbeddingSourceKind;
  id: string;
  sha256: string;
  vector: number[];
};

/** Org-scoped (forced RLS + explicit org filter). */
export interface EmbeddingRepository {
  /** The meeting's current-revision segments and live summary reports, in a stable order, at most `limit`. */
  listSources(organizationId: string, meetingId: string, limit: number): Promise<EmbeddingSource[]>;
  /** Content hashes already stored for the meeting's sources (any model). */
  storedHashes(organizationId: string, meetingId: string): Promise<Map<string, Set<string>>>;
  upsert(
    organizationId: string,
    meetingId: string,
    model: string,
    rows: EmbeddingRow[],
  ): Promise<number>;
}

export type EmbedFn = (req: {
  organizationId: string;
  inputs: string[];
  idempotencyKey: string;
  jobId?: string;
}) => Promise<EmbedBatchResult>;

export type EmbeddingJobPayload = { organizationId: string; meetingId: string };

export interface EmbeddingLimits {
  /** Sources considered per job (segments + summaries). */
  maxSources: number;
  /** Inputs per provider call (<= EMBEDDING_MAX_BATCH). */
  batchSize: number;
}
export const EMBEDDING_LIMIT_DEFAULTS: EmbeddingLimits = { maxSources: 2000, batchSize: 32 };

export type EmbeddingJobResult = {
  status: 'done' | 'unavailable' | 'failed';
  considered: number;
  skipped: number;
  embedded: number;
  calls: number;
};

/** Retry signal for the queue (transient provider trouble); the job is retried with backoff. */
export class EmbeddingRetryableError extends Error {
  constructor(readonly codes: string[]) {
    super('embedding provider temporarily unavailable');
    this.name = 'EmbeddingRetryableError';
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runMeetingEmbeddings(
  deps: {
    repo: EmbeddingRepository;
    embed: EmbedFn;
    log: { info(o: object, m: string): void; warn(o: object, m: string): void };
    limits?: Partial<EmbeddingLimits>;
  },
  job: EmbeddingJobPayload & { jobId?: string },
): Promise<EmbeddingJobResult> {
  const { organizationId, meetingId } = job;
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(meetingId))
    throw new TypeError('embedding job needs organizationId and meetingId uuids');
  const limits = { ...EMBEDDING_LIMIT_DEFAULTS, ...deps.limits };
  const batchSize = Math.min(Math.max(limits.batchSize, 1), EMBEDDING_MAX_BATCH);
  const ids = { organizationId, meetingId };

  const sources = await deps.repo.listSources(organizationId, meetingId, limits.maxSources);
  const stored = await deps.repo.storedHashes(organizationId, meetingId);
  const pending = sources
    .map((s) => ({ ...s, sha256: sha256(`${s.kind}\n${s.text}`) }))
    .filter((s) => s.text.trim() !== '' && !stored.get(s.id)?.has(s.sha256));
  const result: EmbeddingJobResult = {
    status: 'done',
    considered: sources.length,
    skipped: sources.length - pending.length,
    embedded: 0,
    calls: 0,
  };

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const r = await deps.embed({
      organizationId,
      inputs: batch.map((s) => s.text),
      // Same meeting + same content => same key: a retried job reuses the stored result (no second provider call).
      idempotencyKey: `${meetingId}:${sha256(batch.map((s) => `${s.id}:${s.sha256}`).join(','))}`,
      ...(job.jobId ? { jobId: job.jobId } : {}),
    });
    result.calls++;
    if (r.status === 'retryable') throw new EmbeddingRetryableError(r.errors.map((e) => e.code));
    if (r.status !== 'succeeded') {
      result.status = r.status;
      deps.log.warn(
        { ...ids, status: r.status, codes: r.errors.map((e) => e.code) },
        r.status === 'unavailable'
          ? 'embeddings not configured; meeting not indexed'
          : 'meeting embedding failed',
      );
      return result;
    }
    result.embedded += await deps.repo.upsert(
      organizationId,
      meetingId,
      r.model,
      batch.map((s, k) => ({ kind: s.kind, id: s.id, sha256: s.sha256, vector: r.vectors[k]! })),
    );
  }
  deps.log.info({ ...ids, ...result }, 'meeting embeddings');
  return result;
}

/** Producer: one queued job per meeting at a time (deterministic jobId), ids only in the payload. */
export async function enqueueMeetingEmbeddings(
  queue: {
    add(name: string, data: EmbeddingJobPayload, opts: Record<string, unknown>): Promise<unknown>;
  },
  p: EmbeddingJobPayload,
) {
  if (!UUID_RE.test(p.organizationId) || !UUID_RE.test(p.meetingId))
    throw new TypeError('embedding job needs organizationId and meetingId uuids');
  await queue.add(
    EMBEDDINGS_JOB_NAME,
    { organizationId: p.organizationId, meetingId: p.meetingId },
    {
      jobId: `embed-${p.organizationId}-${p.meetingId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
