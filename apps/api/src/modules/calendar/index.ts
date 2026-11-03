import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  CALENDAR_PATHS,
  CalendarCallbackParams,
  CalendarCallbackQuery,
  CalendarConnectionParams,
  CalendarEventLink,
  CalendarEventLinkParams,
  CalendarEventList,
  CalendarProviderList,
  ConnectCalendarRequest,
  ConnectCalendarResponse,
  LinkCalendarEventRequest,
  ListCalendarEventsQuery,
  type CalendarProviderId,
} from '@meetops/contracts';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { isRelaxedEnv, MissingProductionDependencyError } from '../index.js';
import { DirectoryAccess, type DirectoryCaller } from '../directory/access.js';
import { directoryErrors, directoryWriteErrors } from '../directory/http/route-kit.js';
import { ErrorBody } from '../auth/http/schemas.js';
import { OAuthStateInvalidError } from '../integrations/errors.js';
import { selectIntegrationsRuntime, type IntegrationsModuleDeps } from '../integrations/index.js';
import { InMemoryCalendarConnections } from './in-memory.repository.js';
import { PrismaCalendarConnections } from './prisma.repository.js';
import { createCalendarSyncRepository } from '@meetops/database';
import type {
  CalendarConnectionsRepository,
  CalendarEventLinksRepository,
  SyncedCalendarStore,
} from './ports.js';
import { InMemoryCalendarEventLinks, PrismaCalendarEventLinks } from './links.repository.js';
import { InMemoryMeetingRepository } from '../meetings/infrastructure/in-memory.repository.js';
import { CalendarService, type CalendarAuditFn } from './service.js';

export { CALENDAR_PATHS };

const OrgParams = Type.Object(
  { organizationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
const upstreamErrors = { 409: ErrorBody, 502: ErrorBody, 503: ErrorBody } as const;

export type CalendarModuleDeps = IntegrationsModuleDeps & {
  calendarConnections?: CalendarConnectionsRepository;
  /** Read-through store for worker-synced events (tests inject one; Prisma when CALENDAR_SYNC_ENABLED=true). */
  calendarSyncStore?: SyncedCalendarStore;
  /** Calendar event -> meeting links (tests may inject one). */
  calendarEventLinks?: CalendarEventLinksRepository;
};

/** Prisma with a database; in dev/test, an in-memory store over the in-memory meetings; otherwise links are off. */
export function selectCalendarEventLinks(
  deps: CalendarModuleDeps,
): CalendarEventLinksRepository | undefined {
  if (deps.calendarEventLinks) return deps.calendarEventLinks;
  if (deps.db) return new PrismaCalendarEventLinks(deps.db);
  const m = deps.meetings;
  if (m instanceof InMemoryMeetingRepository)
    return new InMemoryCalendarEventLinks(() => m.rows.values());
  return undefined;
}

/** Off by default: only CALENDAR_SYNC_ENABLED=true (with a database) serves synced events. */
export function selectCalendarSyncStore(
  deps: CalendarModuleDeps,
  env: NodeJS.ProcessEnv = process.env,
): SyncedCalendarStore | undefined {
  if (deps.calendarSyncStore) return deps.calendarSyncStore;
  if (env.CALENDAR_SYNC_ENABLED?.trim().toLowerCase() !== 'true' || !deps.db) return undefined;
  const repo = createCalendarSyncRepository({ client: deps.db });
  return {
    coverage: (o, u, c) => repo.coverage(o, u, c),
    listEvents: (o, u, c, f, t) => repo.listEvents(o, u, c, f, t),
  };
}

export function selectCalendarRepository(
  deps: CalendarModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
  runtime = deps.integrationsRuntime,
): CalendarConnectionsRepository {
  if (deps.calendarConnections) return deps.calendarConnections;
  if (deps.db) return new PrismaCalendarConnections(deps.db, runtime?.cipher);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['calendarConnections']);
  return new InMemoryCalendarConnections();
}

/**
 * Phase 7 calendar. Self-service per user: every member (viewers included) may connect and read ONLY their own
 * calendar in their active organization. Order: session (401) -> org membership (404) -> read Organization (403).
 */
export default async function calendarModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: CalendarModuleDeps },
) {
  const { auth, organizations, deps } = opts;
  const runtime = selectIntegrationsRuntime(deps);
  const service = new CalendarService(
    selectCalendarRepository(deps, process.env.NODE_ENV, runtime),
    runtime,
    selectCalendarSyncStore(deps),
    undefined,
    selectCalendarEventLinks(deps),
    app.log,
  );
  const g = makeGuards(auth, deps.security);
  const access = new DirectoryAccess(organizations, deps.audit);
  const auditFor =
    (c: DirectoryCaller): CalendarAuditFn =>
    (action, targetId, metadata) =>
      access.record(c, {
        action,
        targetType: 'calendar_connection',
        targetId,
        ...(metadata ? { metadata } : {}),
      });
  const callerFor = async (request: FastifyRequest, organizationId: string) => {
    const c = await access.caller(
      await g.requireSession(request),
      organizationId,
      requestMeta(request),
    );
    organizations.authorize(c.ctx, 'read', 'Organization');
    return c;
  };

  registerDomainErrorHandler(app);
  app.addHook('onRequest', g.mutationGuard);

  app.get<{ Params: { organizationId: string } }>(
    CALENDAR_PATHS.providers,
    {
      schema: {
        tags: ['calendar'],
        summary: 'Calendar providers, whether each is configured, and my connection',
        params: OrgParams,
        response: { 200: CalendarProviderList, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await callerFor(request, request.params.organizationId);
      return { items: await service.providers(c.ctx.organizationId, c.ctx.userId) };
    },
  );

  app.post<{ Params: { organizationId: string }; Body: ConnectCalendarRequest }>(
    CALENDAR_PATHS.connect,
    {
      schema: {
        tags: ['calendar'],
        summary: 'Start connecting my calendar (OAuth + PKCE)',
        params: OrgParams,
        body: ConnectCalendarRequest,
        response: { 200: ConnectCalendarResponse, ...directoryErrors, ...upstreamErrors },
      },
    },
    async (request) => {
      const c = await callerFor(request, request.params.organizationId);
      return service.connect({
        organizationId: c.ctx.organizationId,
        userId: c.ctx.userId,
        provider: request.body.provider,
        ...(request.body.returnTo ? { returnTo: request.body.returnTo } : {}),
      });
    },
  );

  app.get<{ Params: { provider: CalendarProviderId }; Querystring: CalendarCallbackQuery }>(
    CALENDAR_PATHS.callback,
    {
      schema: {
        tags: ['calendar'],
        summary: 'OAuth callback (redirects back to the web app)',
        params: CalendarCallbackParams,
        querystring: CalendarCallbackQuery,
        response: { ...directoryWriteErrors, ...upstreamErrors },
      },
    },
    async (request, reply) => {
      const inner = service.verifyState(request.query.state);
      const session = await g.requireSession(request);
      const orgId = session.session.activeOrganizationId;
      if (!orgId) throw new OAuthStateInvalidError();
      const c = await callerFor(request, orgId);
      const location = await service.callback({
        provider: request.params.provider,
        organizationId: c.ctx.organizationId,
        userId: c.ctx.userId,
        innerState: inner,
        query: { code: request.query.code, error: request.query.error },
        audit: auditFor(c),
      });
      return reply.header('cache-control', 'no-store').redirect(location, 302);
    },
  );

  app.get<{ Params: { organizationId: string }; Querystring: ListCalendarEventsQuery }>(
    CALENDAR_PATHS.events,
    {
      schema: {
        tags: ['calendar'],
        summary: 'My calendar events in a window (max 62 days)',
        params: OrgParams,
        querystring: ListCalendarEventsQuery,
        response: { 200: CalendarEventList, ...directoryErrors, ...upstreamErrors },
      },
    },
    async (request, reply) => {
      const c = await callerFor(request, request.params.organizationId);
      const { items } = await service.events({
        organizationId: c.ctx.organizationId,
        userId: c.ctx.userId,
        from: request.query.from,
        to: request.query.to,
      });
      reply.header('cache-control', 'private, no-store');
      return { items };
    },
  );

  app.delete<{ Params: { organizationId: string; connectionId: string } }>(
    CALENDAR_PATHS.connection,
    {
      schema: {
        tags: ['calendar'],
        summary: 'Disconnect my calendar (tokens are wiped)',
        params: CalendarConnectionParams,
        response: { 204: Type.Null(), ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await callerFor(request, request.params.organizationId);
      await service.disconnect(
        c.ctx.organizationId,
        c.ctx.userId,
        request.params.connectionId,
        auditFor(c),
      );
      return reply.code(204).send();
    },
  );

  /** Links one of MY events to a meeting of the org. Viewers (no Meeting create) get 403. */
  app.put<{ Params: CalendarEventLinkParams; Body: LinkCalendarEventRequest }>(
    CALENDAR_PATHS.eventLink,
    {
      schema: {
        tags: ['calendar'],
        summary: 'Link one of my calendar events to a meeting',
        params: CalendarEventLinkParams,
        body: LinkCalendarEventRequest,
        response: { 200: CalendarEventLink, ...directoryWriteErrors },
      },
    },
    async (request) => {
      const c = await callerFor(request, request.params.organizationId);
      organizations.authorize(c.ctx, 'create', 'Meeting');
      const row = await service.link(
        {
          organizationId: c.ctx.organizationId,
          userId: c.ctx.userId,
          connectionId: request.params.connectionId,
          eventId: request.params.eventId,
          meetingId: request.body.meetingId,
        },
        auditFor(c),
      );
      return {
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    },
  );

  app.delete<{ Params: CalendarEventLinkParams }>(
    CALENDAR_PATHS.eventLink,
    {
      schema: {
        tags: ['calendar'],
        summary: 'Unlink one of my calendar events from its meeting',
        params: CalendarEventLinkParams,
        response: { 204: Type.Null(), ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await callerFor(request, request.params.organizationId);
      organizations.authorize(c.ctx, 'create', 'Meeting');
      await service.unlink(
        {
          organizationId: c.ctx.organizationId,
          userId: c.ctx.userId,
          connectionId: request.params.connectionId,
          eventId: request.params.eventId,
        },
        auditFor(c),
      );
      return reply.code(204).send();
    },
  );
}
