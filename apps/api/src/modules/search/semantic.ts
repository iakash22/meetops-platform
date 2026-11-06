import type { SemanticSearchKind, SemanticSearchResult } from '@meetops/contracts';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import { DomainError } from '../../shared/domain-error.js';
import {
  SEARCH_STATEMENT_TIMEOUT_MS,
  SearchTimeoutError,
  isStatementTimeout,
} from './prisma.repository.js';

/** Dimension of meeting_embeddings.embedding (migration 20261031050000). */
export const SEMANTIC_EMBEDDING_DIMS = 1536;

/**
 * Turns the query text into a vector, reporting the `provider/model` that produced it so only rows embedded with the
 * same model are ranked. Never logged.
 */
export interface QueryEmbedder {
  /**
   * `opts.signal` aborts when the search request's wall-clock budget runs out (the route has already answered 503).
   * Implementations that can cancel (an HTTP fetch, a provider SDK call) should pass it through.
   */
  embed(
    organizationId: string,
    text: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ vector: number[]; model: string }>;
}

/**
 * Structural twin of `embedWithExecutor` from @meetops/ai-core (kept local so the API needs no new dependency): the
 * host passes `(req) => embedWithExecutor(executor, req)`.
 */
export type ExecutorEmbedFn = (req: {
  organizationId: string;
  inputs: string[];
}) => Promise<
  | { status: 'succeeded'; vectors: number[][]; model: string }
  | { status: 'unavailable' | 'retryable' | 'failed'; errors: { code: string }[] }
>;

/**
 * Production query embedder over the ai-core executor (`embeddings` feature: routing, approval, quotas and usage).
 * Unconfigured by default: until an approved provider is routed for embeddings the executor answers `unavailable`
 * and the route returns 503. Queries are not idempotency-keyed (ad hoc text).
 */
export function createExecutorQueryEmbedder(embed: ExecutorEmbedFn): QueryEmbedder {
  return {
    async embed(organizationId, text, opts) {
      // ai-core's embedWithExecutor / AIExecutor.run take no caller AbortSignal (the executor owns its deadline
      // controller and provider.embed has no signal), so the call cannot be cancelled from here: once the route's
      // budget aborts, the executor run finishes in the background bounded by its own overallTimeoutMs and its
      // result is dropped. Do not start a call for an already-aborted request.
      if (opts?.signal?.aborted) throw new SemanticSearchUnavailableError();
      const r = await embed({ organizationId, inputs: [text] });
      if (r.status !== 'succeeded' || r.vectors.length !== 1)
        throw new SemanticSearchUnavailableError();
      return { vector: r.vectors[0]!, model: r.model };
    },
  };
}

export type SemanticSearchInput = {
  vector: number[];
  model: string;
  kinds: readonly SemanticSearchKind[];
  limit: number;
};

/** Org-scoped semantic search. Implementations must rank ONLY rows of `organizationId` (filter first, then order). */
export interface SemanticSearchRepository {
  search(organizationId: string, input: SemanticSearchInput): Promise<SemanticSearchResult[]>;
}

export class SemanticSearchUnavailableError extends DomainError {
  constructor() {
    super('PROVIDER_UNAVAILABLE', 'Semantic search is not available', 503);
  }
}

/** Off by default: only SEMANTIC_SEARCH_ENABLED=true registers the route. */
export function semanticSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SEMANTIC_SEARCH_ENABLED?.trim().toLowerCase() === 'true';
}

/** pgvector text literal; refuses anything but SEMANTIC_EMBEDDING_DIMS finite numbers. */
export function toVectorLiteral(v: readonly number[]): string {
  if (v.length !== SEMANTIC_EMBEDDING_DIMS || !v.every((x) => Number.isFinite(x)))
    throw new SemanticSearchUnavailableError();
  return `[${v.join(',')}]`;
}

/**
 * The query. Tenant filter FIRST: the MATERIALIZED `scoped` CTE selects only `e.org_id = $1` rows (btree
 * meeting_embeddings_org_id_model_idx) joined to live sources of the same org; only then does the outer query order
 * by distance. There is no ANN index, so Postgres can't rank across tenants and post-filter. All values are bound
 * parameters: $1 org, $2 model, $3 query vector, $4 kinds, $5 limit. Runs under forced RLS as well.
 */
export const SEMANTIC_SEARCH_SQL = `
WITH scoped AS MATERIALIZED (
  SELECT CASE e.source_kind WHEN 'transcript_segment' THEN 'transcript' ELSE 'summary' END AS kind,
         coalesce(e.segment_id, e.report_id) AS id,
         e.meeting_id,
         e.embedding,
         mt.title AS meeting_title,
         sg.text AS segment_text,
         sg.start_ms,
         r.title AS report_title,
         r.summary AS report_summary,
         coalesce(r.created_at, mt.started_at, mt.created_at) AS occurred_at
    FROM meeting_embeddings e
    JOIN meetings mt ON mt.org_id = e.org_id AND mt.id = e.meeting_id AND mt.deleted_at IS NULL
    LEFT JOIN transcript_segments sg ON sg.org_id = e.org_id AND sg.id = e.segment_id
    LEFT JOIN transcripts tr ON tr.org_id = sg.org_id AND tr.id = sg.transcript_id
         AND tr.deleted_at IS NULL AND sg.revision = tr.revision
    LEFT JOIN reports r ON r.org_id = e.org_id AND r.id = e.report_id AND r.deleted_at IS NULL
   WHERE e.org_id = $1::uuid
     AND e.model = $2
     AND ((e.source_kind = 'transcript_segment' AND 'transcript' = ANY($4::text[]) AND tr.id IS NOT NULL)
       OR (e.source_kind = 'summary' AND 'summary' = ANY($4::text[]) AND r.id IS NOT NULL))
)
SELECT s.kind, s.id, s.meeting_id,
       coalesce(s.report_title, s.meeting_title) AS title,
       coalesce(s.segment_text, coalesce(s.report_title, '') || ' ' || coalesce(s.report_summary, '')) AS snippet,
       (1 - (s.embedding <=> $3::vector))::float8 AS score,
       s.start_ms,
       s.occurred_at
  FROM scoped s
 ORDER BY s.embedding <=> $3::vector, s.id
 LIMIT $5`;

type Row = {
  kind: SemanticSearchKind;
  id: string;
  meeting_id: string;
  title: string | null;
  snippet: string | null;
  score: number;
  start_ms: number | null;
  occurred_at: Date;
};

/** LIMIT is a bigint: an integer 1-20; a non-finite value falls back to the maximum. */
const clampLimit = (n: number) =>
  Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 20) : 20;

const clampScore = (x: number) => (Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : -1);

export class PrismaSemanticSearch implements SemanticSearchRepository {
  constructor(private readonly db: DatabaseClient) {}
  async search(organizationId: string, input: SemanticSearchInput) {
    const vec = toVectorLiteral(input.vector);
    const rows = await withOrganizationContext(
      organizationId,
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${SEARCH_STATEMENT_TIMEOUT_MS}ms'`,
        );
        return tx.$queryRawUnsafe<Row[]>(
          SEMANTIC_SEARCH_SQL,
          organizationId,
          input.model,
          vec,
          [...input.kinds],
          clampLimit(input.limit),
        );
      },
      { client: this.db },
    ).catch((e: unknown) => {
      if (isStatementTimeout(e)) throw new SearchTimeoutError();
      throw e;
    });
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      meetingId: r.meeting_id,
      title: (r.title ?? '').slice(0, 500),
      snippet: (r.snippet ?? '').slice(0, 2000),
      score: clampScore(r.score),
      ...(r.start_ms !== null && r.start_ms >= 0 ? { startMs: r.start_ms } : {}),
      occurredAt: r.occurred_at.toISOString(),
    }));
  }
}

export type SemanticDoc = Omit<SemanticSearchResult, 'score'> & {
  organizationId: string;
  model: string;
  vector: number[];
};

/** Dev/test stand-in with the same contract: filters by org and model first, then ranks by cosine similarity. */
export class InMemorySemanticSearch implements SemanticSearchRepository {
  readonly docs: SemanticDoc[] = [];
  async search(organizationId: string, input: SemanticSearchInput) {
    toVectorLiteral(input.vector);
    const cos = (a: number[], b: number[]) => {
      let d = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        d += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return na && nb ? d / Math.sqrt(na * nb) : 0;
    };
    return this.docs
      .filter(
        (d) =>
          d.organizationId === organizationId &&
          d.model === input.model &&
          input.kinds.includes(d.kind),
      )
      .map((d) => ({
        kind: d.kind,
        id: d.id,
        meetingId: d.meetingId,
        title: d.title,
        snippet: d.snippet,
        score: clampScore(cos(d.vector, input.vector)),
        ...(d.startMs !== undefined ? { startMs: d.startMs } : {}),
        occurredAt: d.occurredAt,
      }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, input.limit);
  }
}
