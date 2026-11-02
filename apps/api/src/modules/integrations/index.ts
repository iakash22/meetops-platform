import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  ConnectIntegrationRequest,
  ConnectIntegrationResponse,
  INTEGRATION_PATHS,
  INTEGRATION_WEBHOOK_MAX_BYTES,
  Integration,
  IntegrationCallbackParams,
  IntegrationCallbackQuery,
  IntegrationIssue,
  IntegrationList,
  IntegrationProviderList,
  type IntegrationProviderStatus,
  PushTaskIssueParams,
  PushTaskIssueRequest,
  WebhookAcceptedResponse,
  WebhookParams,
} from '@meetops/contracts';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess, type DirectoryCaller } from '../directory/access.js';
import { directoryErrors, directoryWriteErrors } from '../directory/http/route-kit.js';
import { ErrorBody } from '../auth/http/schemas.js';
import { IntegrationNotFoundError, OAuthStateInvalidError } from './errors.js';
import { InMemoryIntegrations } from './in-memory.repository.js';
import { PrismaIntegrations } from './prisma.repository.js';
import type { ConnectedProvider, IntegrationsRepository } from './ports.js';
import { createRedisConnectionLease, parseSharedKek } from '@meetops/integrations';
import {
  devIntegrationsRuntime,
  integrationsRuntimeFromEnv,
  leaseRedisFromEval,
  refusingTokenRefreshLease,
  type IntegrationsRuntime,
} from './runtime.js';
import { IntegrationsService, type AuditFn } from './service.js';

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
const upstreamErrors = { 409: ErrorBody, 502: ErrorBody, 503: ErrorBody } as const;

export type IntegrationsModuleDeps = ModuleDeps & {
  integrations?: IntegrationsRepository;
  /** Secrets, stores and provider apps for connect/callback/webhook/push (see runtime.ts). */
  integrationsRuntime?: IntegrationsRuntime;
};

export function selectIntegrationsRuntime(
  deps: IntegrationsModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationsRuntime | undefined {
  // Fail closed at startup: the dev-only shared KEK must never be set in production (ADR-008), even when the
  // runtime is injected or the dev runtime is skipped. parseSharedKek names the variable only, never the value.
  if (nodeEnv === 'production') parseSharedKek({ ...env, NODE_ENV: 'production' });
  const rt =
    deps.integrationsRuntime ??
    (isRelaxedEnv(nodeEnv) ? devIntegrationsRuntime(integrationsRuntimeFromEnv()) : undefined);
  return rt && withTokenRefreshLease(rt, deps, nodeEnv);
}

/**
 * The API's on-demand Jira refresh takes the same per-connection lease as the worker sweep (#375 F1). Built from
 * deps.redis unless the runtime already carries one; outside development/test without Redis it refuses (fail
 * closed) rather than refreshing a rotating grant unguarded.
 */
export function withTokenRefreshLease(
  rt: IntegrationsRuntime,
  deps: Pick<ModuleDeps, 'redis'>,
  nodeEnv: string | undefined,
): IntegrationsRuntime {
  if (rt.tokenRefreshLease) return rt;
  if (deps.redis)
    return { ...rt, tokenRefreshLease: createRedisConnectionLease(leaseRedisFromEval(deps.redis)) };
  return isRelaxedEnv(nodeEnv) ? rt : { ...rt, tokenRefreshLease: refusingTokenRefreshLease };
}

export function selectIntegrationsRepository(
  deps: IntegrationsModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  runtime: IntegrationsRuntime | undefined = deps.integrationsRuntime,
): IntegrationsRepository {
  if (deps.integrations) return deps.integrations;
  if (deps.db) return new PrismaIntegrations(deps.db, runtime?.cipher);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['integrations']);
  return new InMemoryIntegrations();
}

/**
 * Phase 5 (ADR-007/ADR-008). Session routes (CSRF + Origin checked): list (read Organization), disconnect, connect,
 * OAuth/App-install callback and issue push (update Organization). Webhooks live in a separate scope with a raw
 * Buffer body (signature over the exact bytes), a 1 MiB limit and no session.
 */
export default async function integrationsModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: IntegrationsModuleDeps },
) {
  const { auth, organizations, deps } = opts;
  const runtime = selectIntegrationsRuntime(deps);
  const repo = selectIntegrationsRepository(deps, process.env.NODE_ENV, runtime);
  const service = new IntegrationsService(repo, runtime);
  const g = makeGuards(auth, deps.security);
  const access = new DirectoryAccess(organizations, deps.audit);
  const auditFor =
    (c: DirectoryCaller): AuditFn =>
    (action, targetId, metadata) =>
      access.record(c, { action, targetType: 'integration', targetId, metadata });
  const callerFor = async (request: FastifyRequest, organizationId: string) =>
    access.caller(await g.requireSession(request), organizationId, requestMeta(request));

  await app.register(async (s) => {
    registerDomainErrorHandler(s);
    s.addHook('onRequest', g.mutationGuard);

    s.get<{ Params: { organizationId: string } }>(
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
        const c = await callerFor(request, request.params.organizationId);
        organizations.authorize(c.ctx, 'read', 'Organization');
        return { items: (await repo.list(c.ctx.organizationId)).slice(0, 50) };
      },
    );

    s.get<{ Params: { organizationId: string } }>(
      INTEGRATION_PATHS.providers,
      {
        schema: {
          tags: ['integrations'],
          summary:
            "Supported providers, whether each is configured, and this org's connection status",
          params: OrgParams,
          response: { 200: IntegrationProviderList, ...directoryErrors },
        },
      },
      async (request) => {
        const c = await callerFor(request, request.params.organizationId);
        organizations.authorize(c.ctx, 'read', 'Organization');
        const rows = await repo.list(c.ctx.organizationId);
        const items: IntegrationProviderStatus[] = (['github', 'jira'] as const).map((provider) => {
          const mine = rows
            .filter((r) => r.provider === provider)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const pick = mine.find((r) => r.status !== 'revoked') ?? mine[0];
          return {
            provider,
            configured: Boolean(runtime?.[provider]),
            connectionStatus: pick ? pick.status : 'not_connected',
            ...(pick ? { integration: pick } : {}),
          };
        });
        return { items };
      },
    );

    s.post<{ Params: { organizationId: string }; Body: ConnectIntegrationRequest }>(
      INTEGRATION_PATHS.connect,
      {
        schema: {
          tags: ['integrations'],
          summary: 'Start connecting Jira (OAuth 3LO + PKCE) or GitHub (App install)',
          params: OrgParams,
          body: ConnectIntegrationRequest,
          response: { 200: ConnectIntegrationResponse, ...directoryErrors, ...upstreamErrors },
        },
      },
      async (request) => {
        const c = await callerFor(request, request.params.organizationId);
        organizations.authorize(c.ctx, 'update', 'Organization');
        return service.connect({
          organizationId: c.ctx.organizationId,
          userId: c.ctx.userId,
          provider: request.body.provider,
          ...(request.body.returnTo ? { returnTo: request.body.returnTo } : {}),
        });
      },
    );

    s.get<{ Params: { provider: ConnectedProvider }; Querystring: IntegrationCallbackQuery }>(
      INTEGRATION_PATHS.callback,
      {
        schema: {
          tags: ['integrations'],
          summary: 'OAuth / App-install callback (redirects back to the web app)',
          params: IntegrationCallbackParams,
          querystring: IntegrationCallbackQuery,
          response: { ...directoryWriteErrors, ...upstreamErrors },
        },
      },
      async (request, reply) => {
        const inner = service.verifyState(request.query.state);
        const session = await g.requireSession(request);
        const orgId = session.session.activeOrganizationId;
        if (!orgId) throw new OAuthStateInvalidError();
        const c = await access.caller(session, orgId, requestMeta(request));
        organizations.authorize(c.ctx, 'update', 'Organization');
        const location = await service.callback({
          provider: request.params.provider,
          organizationId: c.ctx.organizationId,
          userId: c.ctx.userId,
          innerState: inner,
          query: request.query,
          audit: auditFor(c),
        });
        return reply.header('cache-control', 'no-store').redirect(location, 302);
      },
    );

    s.delete<{ Params: { organizationId: string; integrationId: string } }>(
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
        const c = await callerFor(request, request.params.organizationId);
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

    s.post<{ Params: PushTaskIssueParams; Body: PushTaskIssueRequest }>(
      INTEGRATION_PATHS.issuePush,
      {
        schema: {
          tags: ['integrations'],
          summary: 'Create the external issue for an approved task',
          params: PushTaskIssueParams,
          body: PushTaskIssueRequest,
          response: { 201: IntegrationIssue, ...directoryWriteErrors, ...upstreamErrors },
        },
      },
      async (request, reply) => {
        const c = await callerFor(request, request.params.organizationId);
        organizations.authorize(c.ctx, 'update', 'Organization');
        const link = await service.pushIssue({
          organizationId: c.ctx.organizationId,
          taskId: request.params.taskId,
          ...request.body,
          audit: auditFor(c),
        });
        return reply.status(201).send(link);
      },
    );
  });

  await app.register(async (s) => {
    registerDomainErrorHandler(s);
    s.removeContentTypeParser('application/json');
    s.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: INTEGRATION_WEBHOOK_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    s.post<{ Body: Buffer }>(
      INTEGRATION_PATHS.githubAppWebhook,
      {
        bodyLimit: INTEGRATION_WEBHOOK_MAX_BYTES,
        schema: {
          tags: ['integrations'],
          summary: 'App-wide GitHub webhook (HMAC with the App secret, routed by installation id)',
          response: {
            202: WebhookAcceptedResponse,
            400: ErrorBody,
            401: ErrorBody,
            409: ErrorBody,
            413: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        await service.githubAppWebhook({ rawBody: body, headers: request.headers });
        return reply.status(202).send({ received: true });
      },
    );
    s.post<{ Params: WebhookParams; Body: Buffer }>(
      INTEGRATION_PATHS.webhook,
      {
        bodyLimit: INTEGRATION_WEBHOOK_MAX_BYTES,
        schema: {
          tags: ['integrations'],
          summary: 'Provider webhook (HMAC-SHA256 signed, replay-protected)',
          params: WebhookParams,
          response: {
            202: WebhookAcceptedResponse,
            400: ErrorBody,
            401: ErrorBody,
            409: ErrorBody,
            413: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        await service.webhook({
          provider: request.params.provider,
          integrationId: request.params.integrationId,
          rawBody: body,
          headers: request.headers,
        });
        return reply.status(202).send({ received: true });
      },
    );
  });
}
