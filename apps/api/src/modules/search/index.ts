import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  SEARCH_PATHS,
  SEARCH_RESULT_KINDS,
  SearchQuery,
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
import { InMemorySearch } from './in-memory.repository.js';
import { PrismaSearch } from './prisma.repository.js';
import type { SearchRepository } from './ports.js';

export { SEARCH_PATHS };

const OrgParams = Type.Object(
  { organizationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);

export type SearchModuleDeps = ModuleDeps & { search?: SearchRepository };

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
        response: { 200: SearchResponse, ...directoryErrors },
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
      const q = request.query.q.trim();
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
}
