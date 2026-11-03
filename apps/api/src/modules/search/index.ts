import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  SEARCH_PATHS,
  SEARCH_RESULT_KINDS,
  SEMANTIC_SEARCH_KINDS,
  SearchQuery,
  SemanticSearchQuery,
  SemanticSearchResponse,
  type SemanticSearchKind,
  SearchResponse,
  type SearchResultKind,
} from '@meetops/contracts';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess } from '../directory/access.js';
import { directoryErrors } from '../directory/http/route-kit.js';
import { ErrorBody } from '../auth/http/schemas.js';
import { RateLimitedError } from '../auth/domain/errors.js';
import { InMemorySearch } from './in-memory.repository.js';
import { PrismaSearch } from './prisma.repository.js';
import { DomainError } from '../../shared/domain-error.js';
import type { SearchRepository } from './ports.js';
import {
  InMemorySemanticSearch,
  PrismaSemanticSearch,
  semanticSearchEnabled,
  SemanticSearchUnavailableError,
  createExecutorQueryEmbedder,
  type ExecutorEmbedFn,
  type QueryEmbedder,
  type SemanticSearchRepository,
} from './semantic.js';

export { SEARCH_PATHS };

/** Per user per org: 30 searches per minute. */
export const SEARCH_RATE_LIMIT = { limit: 30, windowMs: 60_000 } as const;
/** Matches the pattern in SearchQuery; the handler re-checks in case validation is bypassed. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const OrgParams = Type.Object(
  { organizationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export class SearchQueryInvalidError extends DomainError {
  constructor() {
    super('VALIDATION_FAILED', 'Search query contains invalid characters', 400);
  }
}

export type SearchModuleDeps = ModuleDeps & {
  search?: SearchRepository;
  /** Phase 7 semantic search (only used when SEMANTIC_SEARCH_ENABLED=true). */
  semanticSearch?: SemanticSearchRepository;
  /** Query embedder (ai-core Embeddings). Without one the semantic route answers 503. */
  queryEmbedder?: QueryEmbedder;
  /** ai-core `embedWithExecutor` bound to the host's executor; used when no queryEmbedder is injected. */
  embeddingsExecutor?: ExecutorEmbedFn;
};

export function selectSemanticSearchRepository(
  deps: SearchModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SemanticSearchRepository {
  if (deps.semanticSearch) return deps.semanticSearch;
  if (deps.db) return new PrismaSemanticSearch(deps.db);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['semanticSearch']);
  return new InMemorySemanticSearch();
}

export function selectSearchRepository(
  deps: SearchModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SearchRepository {
  if (deps.search) return deps.search;
  if (deps.db) return new PrismaSearch(deps.db);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['search']);
  return new InMemorySearch();
}

/**
 * Phase 7 meeting search. Order: session (401) -> org membership (404) -> CASL read Meeting + read Task (403) ->
 * repository (forced RLS, org-scoped).
 */
export default async function searchModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: SearchModuleDeps },
) {
  const { auth, organizations, deps } = opts;
  const repo = selectSearchRepository(deps);
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  app.addHook('onRequest', g.mutationGuard);
  const access = new DirectoryAccess(organizations, deps.audit);

  app.get<{ Params: { organizationId: string }; Querystring: SearchQuery }>(
    SEARCH_PATHS.search,
    {
      schema: {
        tags: ['search'],
        summary: 'Full-text search across meetings, transcripts, summaries and tasks',
        params: OrgParams,
        querystring: SearchQuery,
        response: { 200: SearchResponse, ...directoryErrors, 429: ErrorBody, 503: ErrorBody },
      },
    },
    async (request, reply) => {
      const c = await access.caller(
        await g.requireSession(request),
        request.params.organizationId,
        requestMeta(request),
      );
      organizations.authorize(c.ctx, 'read', 'Meeting');
      organizations.authorize(c.ctx, 'read', 'Task');
      const rl = await deps.rateLimiter.consume(
        `search:${c.ctx.organizationId}:${c.ctx.userId}`,
        SEARCH_RATE_LIMIT.limit,
        SEARCH_RATE_LIMIT.windowMs,
      );
      if (!rl.allowed) throw new RateLimitedError(rl.retryAfterMs);
      const q = request.query.q.trim();
      if (CONTROL_CHARS.test(q)) throw new SearchQueryInvalidError();
      const kinds = request.query.kinds
        ? ([...new Set(request.query.kinds.split(','))] as SearchResultKind[])
        : [...SEARCH_RESULT_KINDS];
      reply.header('cache-control', 'private, no-store');
      if (q.length < 2) return { items: [] };
      const items = await repo.search(c.ctx.organizationId, {
        q,
        kinds,
        limit: request.query.limit ?? 20,
      });
      return { items };
    },
  );

  if (!semanticSearchEnabled()) return;
  const semantic = selectSemanticSearchRepository(deps);
  const embedder =
    deps.queryEmbedder ??
    (deps.embeddingsExecutor ? createExecutorQueryEmbedder(deps.embeddingsExecutor) : undefined);
  app.get<{ Params: { organizationId: string }; Querystring: SemanticSearchQuery }>(
    SEARCH_PATHS.semantic,
    {
      schema: {
        tags: ['search'],
        summary: 'Semantic (vector) search across transcripts and summaries',
        params: OrgParams,
        querystring: SemanticSearchQuery,
        response: {
          200: SemanticSearchResponse,
          ...directoryErrors,
          429: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const c = await access.caller(
        await g.requireSession(request),
        request.params.organizationId,
        requestMeta(request),
      );
      organizations.authorize(c.ctx, 'read', 'Meeting');
      const rl = await deps.rateLimiter.consume(
        `search:${c.ctx.organizationId}:${c.ctx.userId}`,
        SEARCH_RATE_LIMIT.limit,
        SEARCH_RATE_LIMIT.windowMs,
      );
      if (!rl.allowed) throw new RateLimitedError(rl.retryAfterMs);
      const q = request.query.q.trim();
      if (CONTROL_CHARS.test(q)) throw new SearchQueryInvalidError();
      reply.header('cache-control', 'private, no-store');
      if (q.length < 2) return { items: [] };
      if (!embedder) throw new SemanticSearchUnavailableError();
      let embedded: { vector: number[]; model: string };
      try {
        embedded = await embedder.embed(c.ctx.organizationId, q);
      } catch {
        throw new SemanticSearchUnavailableError();
      }
      const kinds = request.query.kinds
        ? ([...new Set(request.query.kinds.split(','))] as SemanticSearchKind[])
        : [...SEMANTIC_SEARCH_KINDS];
      const items = await semantic.search(c.ctx.organizationId, {
        vector: embedded.vector,
        model: embedded.model,
        kinds,
        limit: request.query.limit ?? 10,
      });
      return { items };
    },
  );
}
