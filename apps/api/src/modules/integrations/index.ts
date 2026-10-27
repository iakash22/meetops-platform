import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { INTEGRATION_PATHS, Integration, IntegrationList } from '@meetops/contracts';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess } from '../directory/access.js';
import { directoryErrors } from '../directory/http/route-kit.js';
import { IntegrationNotFoundError } from './errors.js';
import { InMemoryIntegrations } from './in-memory.repository.js';
import { PrismaIntegrations } from './prisma.repository.js';
import type { IntegrationsRepository } from './ports.js';

const OrgParams = Type.Object(
  { organizationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const ItemParams = Type.Object(
  {
    organizationId: Type.String({ format: 'uuid' }),
    integrationId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false },
);

export type IntegrationsModuleDeps = ModuleDeps & { integrations?: IntegrationsRepository };

export function selectIntegrationsRepository(
  deps: IntegrationsModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): IntegrationsRepository {
  if (deps.integrations) return deps.integrations;
  if (deps.db) return new PrismaIntegrations(deps.db);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['integrations']);
  return new InMemoryIntegrations();
}

/**
 * Phase 5 (ADR-008), first slice: list and disconnect. Any member may list (no secrets are ever returned);
 * only owners/admins (CASL update Organization) may disconnect. Disconnect is a soft revoke that wipes the secrets.
 * connect, OAuth callback, webhooks and issue push wait for @meetops/integrations in apps/api (lockfile step).
 */
export default async function integrationsModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: IntegrationsModuleDeps },
) {
  const { auth, organizations, deps } = opts;
  const repo = selectIntegrationsRepository(deps);
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  const access = new DirectoryAccess(organizations, deps.audit);

  app.get<{ Params: { organizationId: string } }>(
    INTEGRATION_PATHS.integrations,
    {
      schema: {
        tags: ['integrations'],
        summary: "List the organization's integrations",
        params: OrgParams,
        response: { 200: IntegrationList, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await access.caller(
        await g.requireSession(request),
        request.params.organizationId,
        requestMeta(request),
      );
      organizations.authorize(c.ctx, 'read', 'Organization');
      return { items: (await repo.list(c.ctx.organizationId)).slice(0, 50) };
    },
  );

  app.delete<{ Params: { organizationId: string; integrationId: string } }>(
    INTEGRATION_PATHS.integration,
    {
      schema: {
        tags: ['integrations'],
        summary: 'Disconnect an integration',
        description:
          'Soft revoke: status becomes revoked and every stored secret is wiped. Idempotent.',
        params: ItemParams,
        response: { 200: Integration, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await access.caller(
        await g.requireSession(request),
        request.params.organizationId,
        requestMeta(request),
      );
      organizations.authorize(c.ctx, 'update', 'Organization');
      const r = await repo.disconnect(c.ctx.organizationId, request.params.integrationId);
      if (!r) throw new IntegrationNotFoundError();
      await access.record(c, {
        action: 'integration.disconnect',
        targetType: 'integration',
        targetId: r.id,
        metadata: { provider: r.provider },
      });
      return r;
    },
  );
}
