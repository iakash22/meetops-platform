import { createHash } from 'node:crypto';
import { EMBEDDING_MAX_BATCH, type EmbedBatchResult } from '@meetops/ai-core';

/**
 * Phase 7 semantic search, PR 2: embeds a meeting's current transcript segments and summaries into
 * meeting_embeddings. Off by default (SEMANTIC_EMBEDDINGS_ENABLED) and, even when on, nothing is embedded until an
 * approved provider is routed for the ai-core `embeddings` feature (no default provider has the capability).
 * Content is hashed: a source is skipped only when it already has a vector for the same text AND the model that is
 * routed now, so a provider/model change re-embeds everything (the search side only matches the current model).
 * Only ids, counts and
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
  /** Stored content hashes per source id, then per model (`provider/model`). */
  storedHashes(
    organizationId: string,
    meetingId: string,
  ): Promise<Map<string, Map<string, string>>>;
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
  idempotencyKey?: string;
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
  const hashed = sources
    .filter((s) => s.text.trim() !== '')
    .map((s) => ({ ...s, sha256: sha256(`${s.kind}\n${s.text}`) }));
  const fresh = (s: (typeof hashed)[number], model: string) =>
    stored.get(s.id)?.get(model) === s.sha256;
  const result: EmbeddingJobResult = {
    status: 'done',
    considered: sources.length,
    skipped: sources.length - hashed.length,
    embedded: 0,
    calls: 0,
  };

  // The routed model is only known from a provider answer. Until one arrives, a source counts as up to date when it
  // has a vector for its current text under ANY model; the first call then tells us the model, and from there on
  // only vectors of that model count (so a model/provider change re-embeds sources whose text did not change).
  let model: string | undefined;
  let queue = hashed.filter((s) => ![...(stored.get(s.id)?.values() ?? [])].includes(s.sha256));
  if (queue.length === 0 && hashed.length > 0) queue = hashed.slice(0, 1); // probe: learn the current model
  const done = new Set<string>();

  while (queue.length > 0) {
    const batch = queue.slice(0, batchSize);
    queue = queue.slice(batchSize);
    // The first call of a run goes to the provider live (no idempotency key), so a cached answer can never report a
    // stale model. Later calls are keyed by meeting + model + content: a retried job reuses the stored result.
    const r = await deps.embed({
      organizationId,
      inputs: batch.map((s) => s.text),
      ...(model
        ? {
            idempotencyKey: `${meetingId}:${sha256(`${model}|${batch.map((s) => `${s.id}:${s.sha256}`).join(',')}`)}`,
          }
        : {}),
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
      result.skipped = sources.length - result.embedded;
      return result;
    }
    const toWrite = batch.filter((s) => !fresh(s, r.model));
    if (toWrite.length > 0)
      result.embedded += await deps.repo.upsert(
        organizationId,
        meetingId,
        r.model,
        toWrite.map((s) => ({
          kind: s.kind,
          id: s.id,
          sha256: s.sha256,
          vector: r.vectors[batch.indexOf(s)]!,
        })),
      );
    for (const s of batch) done.add(s.id);
    if (model !== r.model) {
      model = r.model;
      // Now that the model is known, queue every source that has no vector of this model for its current text.
      const queued = new Set(queue.map((s) => s.id));
      for (const s of hashed)
        if (!done.has(s.id) && !queued.has(s.id) && !fresh(s, model)) queue.push(s);
    }
  }
  result.skipped = sources.length - result.embedded;
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
