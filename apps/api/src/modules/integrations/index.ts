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
  TaskSyncJob,
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
import { RateLimitedError } from '../auth/domain/errors.js';
import {
  IntegrationNotFoundError,
  OAuthStateInvalidError,
  WebhookSignatureError,
} from './errors.js';
import { InMemoryIntegrations } from './in-memory.repository.js';
import { PrismaIntegrations } from './prisma.repository.js';
import type { ConnectedProvider, IntegrationsRepository } from './ports.js';
import {
  createRedisConnectionLease,
  parseSharedKek,
  RedisDeliveryStore,
} from '@meetops/integrations';
import {
  devIntegrationsRuntime,
  integrationsRuntimeFromEnv,
  deliveryRedisFromEval,
  leaseRedisFromEval,
  refusingTokenRefreshLease,
  type IntegrationsRuntime,
} from './runtime.js';
import { IntegrationsService, type AuditFn } from './service.js';
import {
  InMemoryTaskSyncStore,
  PrismaTaskSyncStore,
  TaskSyncService,
  createBullMqTaskSyncQueue,
  taskSyncEnabled,
  toTaskSyncJob,
  type TaskSyncQueue,
  type TaskSyncStore,
} from './task-sync.js';

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
  /** Overrides TASK_SYNC_ENABLED (tests). Off by default: the sync route is not registered. */
  taskSyncEnabled?: boolean;
  taskSyncStore?: TaskSyncStore;
  taskSyncQueue?: TaskSyncQueue;
  /** Overrides WEBHOOK_RATE_LIMITS (tests). */
  webhookRateLimits?: WebhookRateLimits;
};

export type WebhookRateLimits = {
  /** Per client IP, across all webhook routes. */
  perIp: { limit: number; windowMs: number };
  /** Per webhook target (provider + integration, or the App-wide GitHub route). */
  perTarget: { limit: number; windowMs: number };
  /**
   * Small per-IP bucket charged only by App-wide GitHub deliveries whose signature is missing or invalid, so
   * unauthenticated junk can neither drain the shared 'github-app' target bucket nor be retried cheaply.
   * Defaults to WEBHOOK_RATE_LIMITS.unsignedPerIp.
   */
  unsignedPerIp?: { limit: number; windowMs: number };
};

/**
 * Unauthenticated webhook routes are checked before the HMAC is computed, so a flood is rejected cheaply (429 +
 * Retry-After). Limits are generous: providers retry on 429, and GitHub/Jira deliver from shared egress IPs.
 */
export const WEBHOOK_RATE_LIMITS: WebhookRateLimits = {
  perIp: { limit: 600, windowMs: 60_000 },
  perTarget: { limit: 300, windowMs: 60_000 },
  unsignedPerIp: { limit: 20, windowMs: 60_000 },
};

/** Store + queue for the async sync route, or undefined when TASK_SYNC_ENABLED is off. Never silently in-memory. */
export function selectTaskSync(
  deps: IntegrationsModuleDeps,
  env: Record<string, string | undefined> = process.env,
): { store: TaskSyncStore; queue: TaskSyncQueue; owned: boolean } | undefined {
  if (!(deps.taskSyncEnabled ?? taskSyncEnabled(env))) return undefined;
  let store = deps.taskSyncStore;
  if (!store && deps.db) store = new PrismaTaskSyncStore(deps.db);
  if (!store) {
    if (!isRelaxedEnv(env.NODE_ENV)) throw new MissingProductionDependencyError(['taskSyncStore']);
    store = new InMemoryTaskSyncStore();
  }
  if (deps.taskSyncQueue) return { store, queue: deps.taskSyncQueue, owned: false };
  if (!env.REDIS_URL)
    throw new Error('TASK_SYNC_ENABLED=true requires REDIS_URL (task sync queue)');
  return { store, queue: createBullMqTaskSyncQueue(env.REDIS_URL), owned: true };
}

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
  return rt && withTokenRefreshLease(withDeliveryStore(rt, deps, nodeEnv), deps, nodeEnv);
}

/**
 * Webhook replay marks must be shared across replicas. Outside development/test the runtime's delivery store is
 * replaced by RedisDeliveryStore on the API's shared Redis client (deps.redis, REDIS_CLIENT_OPTIONS with
 * commandTimeout), unless it is already a shared store. Without Redis there it fails closed at startup. Only
 * development/test (isRelaxedEnv; unset, 'Production', 'prod', 'staging' are not relaxed) may keep the in-memory store.
 */
export function withDeliveryStore(
  rt: IntegrationsRuntime,
  deps: Pick<ModuleDeps, 'redis'>,
  nodeEnv: string | undefined,
): IntegrationsRuntime {
  if (isRelaxedEnv(nodeEnv) || rt.deliveryStore.shared === true) return rt;
  if (deps.redis)
    return { ...rt, deliveryStore: new RedisDeliveryStore(deliveryRedisFromEval(deps.redis)) };
  throw new Error(
    'Integrations runtime: a shared webhook delivery store (RedisDeliveryStore) is required outside development/test; set REDIS_URL',
  );
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
  const service = new IntegrationsService(repo, runtime, app.log);
  const taskSync = selectTaskSync(deps);
  const syncService = taskSync
    ? new TaskSyncService(repo, taskSync.store, taskSync.queue)
    : undefined;
  if (taskSync?.owned) app.addHook('onClose', async () => taskSync.queue.close?.());
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

    if (syncService)
      s.post<{ Params: PushTaskIssueParams; Body: PushTaskIssueRequest }>(
        INTEGRATION_PATHS.taskSync,
        {
          schema: {
            tags: ['integrations'],
            summary:
              'Queue the external issue for an approved task (async, idempotent per task + integration)',
            params: PushTaskIssueParams,
            body: PushTaskIssueRequest,
            response: { 202: TaskSyncJob, ...directoryWriteErrors, ...upstreamErrors },
          },
        },
        async (request, reply) => {
          const c = await callerFor(request, request.params.organizationId);
          organizations.authorize(c.ctx, 'update', 'Organization');
          const job = await syncService.request({
            organizationId: c.ctx.organizationId,
            userId: c.ctx.userId,
            taskId: request.params.taskId,
            ...request.body,
          });
          await access.record(c, {
            action: 'integration.task_sync_requested',
            targetType: 'integration',
            targetId: job.integrationId,
            metadata: { taskId: job.taskId, syncId: job.id, status: job.status },
          });
          return reply.status(202).send(toTaskSyncJob(job));
        },
      );
  });

  await app.register(async (s) => {
    registerDomainErrorHandler(s);
    const limits = deps.webhookRateLimits ?? WEBHOOK_RATE_LIMITS;
    const consumeOrThrow = async (key: string, l: { limit: number; windowMs: number }) => {
      const r = await deps.rateLimiter.consume(key, l.limit, l.windowMs);
      if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
    };
    s.addHook('onRequest', async (request) => {
      const ip = requestMeta(request).ip ?? 'unknown';
      await consumeOrThrow(`webhook:ip:${ip}`, limits.perIp);
    });
    /**
     * Per-target buckets ('github-app' and provider:integration) are charged only once a delivery passed the
     * signature AND replay checks, so unsigned floods or replays of one valid delivery cannot use them up.
     * Missing/invalid signatures (and unknown integration ids, which look the same) go to a small per-IP bucket.
     */
    const chargeWebhook = async (
      request: FastifyRequest,
      target: string,
      run: (onDeliveryAccepted: () => Promise<void>) => Promise<unknown>,
    ) => {
      let accepted = false;
      try {
        await run(async () => {
          accepted = true;
          await consumeOrThrow(`webhook:target:${target}`, limits.perTarget);
        });
      } catch (err) {
        if (!accepted && err instanceof WebhookSignatureError) {
          const ip = requestMeta(request).ip ?? 'unknown';
          await consumeOrThrow(
            `webhook:unsigned:ip:${ip}`,
            limits.unsignedPerIp ?? WEBHOOK_RATE_LIMITS.unsignedPerIp!,
          );
        }
        throw err;
      }
    };
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
            429: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        await chargeWebhook(request, 'github-app', (onDeliveryAccepted) =>
          service.githubAppWebhook({ rawBody: body, headers: request.headers, onDeliveryAccepted }),
        );
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
            429: ErrorBody,
            503: ErrorBody,
          },
        },
      },
      async (request, reply) => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const { provider, integrationId } = request.params;
        await chargeWebhook(request, `${provider}:${integrationId}`, (onDeliveryAccepted) =>
          service.webhook({
            provider,
            integrationId,
            rawBody: body,
            headers: request.headers,
            onDeliveryAccepted,
          }),
        );
        return reply.status(202).send({ received: true });
      },
    );
  });
}
