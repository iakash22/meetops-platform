import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  ListNotificationsQuery,
  MarkNotificationsReadResponse,
  NOTIFICATION_PATHS,
  NotificationList,
  NotificationOrgParams,
  NotificationParams,
  NotificationPreferences,
  PushDevice,
  PushDeviceParams,
  RegisterPushDeviceRequest,
  UnsubscribeQuery,
  UnsubscribeResponse,
  UpdateNotificationPreferencesRequest,
} from '@meetops/contracts';
import { LocalKeyProvider, TokenCipher } from '@meetops/integrations';
import type { PushTokenCipher } from '@meetops/database';
import {
  PushTargetRejectedError,
  pushTokenFromRegistration,
  verifyEmailLinkToken,
} from '@meetops/notifications';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { defineAbilityFor, orgSubject } from '../organizations/domain/abilities.js';
import { ForbiddenError, OrganizationNotFoundError } from '../organizations/domain/errors.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess } from '../directory/access.js';
import { directoryErrors, directoryWriteErrors } from '../directory/http/route-kit.js';
import { ErrorBody } from '../auth/http/schemas.js';
import {
  NotificationsUnavailableError,
  PushTargetInvalidError,
  UnsubscribeLinkInvalidError,
} from './errors.js';
import { InMemoryNotifications } from './in-memory.repository.js';
import { PrismaNotifications } from './prisma.repository.js';
import type { NotificationsRepository } from './ports.js';

export type NotificationsModuleDeps = ModuleDeps & {
  notifications?: NotificationsRepository;
  /** ADR-008 envelope cipher for push tokens (AAD = org + device id). Dev/test get a random-key cipher. */
  pushTokenCipher?: PushTokenCipher;
  /** >= 32 bytes; signs unsubscribe / preferences links (EMAIL_LINK_SECRET). */
  emailLinkSecret?: string;
};

export function devPushTokenCipher(): PushTokenCipher {
  const c = new TokenCipher(new LocalKeyProvider({ dev: randomBytes(32) }, 'dev'));
  return {
    encrypt: (p, x) => c.encrypt(p, { organizationId: x.organizationId, integrationId: x.deviceId }),
    decrypt: (e, x) => c.decrypt(e, { organizationId: x.organizationId, integrationId: x.deviceId }),
  };
}

export function selectNotificationsRepository(
  deps: NotificationsModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): NotificationsRepository {
  if (deps.notifications) return deps.notifications;
  const relaxed = isRelaxedEnv(nodeEnv);
  if (deps.db)
    return new PrismaNotifications(
      deps.db,
      deps.pushTokenCipher ?? (relaxed ? devPushTokenCipher() : undefined),
    );
  if (!relaxed) throw new MissingProductionDependencyError(['notifications']);
  return new InMemoryNotifications();
}

const escapeAttr = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** GET never changes state (link scanners); the form POSTs back to the same URL. */
export function unsubscribeConfirmPage(token: string): string {
  const action = `${NOTIFICATION_PATHS.unsubscribe}?token=${encodeURIComponent(token)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe - MeetOps</title></head>
<body><main><h1>Unsubscribe from these emails?</h1><p>You can change this later in your notification settings.</p>
<form method="post" action="${escapeAttr(action)}"><button type="submit">Unsubscribe</button></form></main></body></html>`;
}

/**
 * ADR-013 routes. Session routes (CSRF + Origin checked by the mutation guard): feed list and mark-read, preferences,
 * push device register/unregister. Order on every route: session (401) -> path org must be the active org and the
 * caller a member (404) -> CASL on the caller's own row (403) -> repository (forced RLS + owner_only).
 * Unsubscribe is token-authenticated (signed, expiring, user+org+category scoped): GET confirm page, POST applies.
 */
export default async function notificationsModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: NotificationsModuleDeps; repo?: NotificationsRepository },
) {
  const { auth, organizations, deps } = opts;
  const repo = opts.repo ?? selectNotificationsRepository(deps);
  const g = makeGuards(auth, deps.security);
  const access = new DirectoryAccess(organizations, deps.audit);
  const linkSecret =
    deps.emailLinkSecret ??
    process.env.EMAIL_LINK_SECRET ??
    (isRelaxedEnv(process.env.NODE_ENV) ? randomBytes(32).toString('base64url') : undefined);

  const self = async (
    request: FastifyRequest,
    organizationId: string,
    action: 'read' | 'update' | 'create' | 'delete',
    subject: 'Notification' | 'NotificationPreference' | 'PushDevice',
    session?: Awaited<ReturnType<typeof g.requireSession>>,
  ) => {
    const c = await access.caller(session ?? (await g.requireSession(request)), organizationId, requestMeta(request));
    const target = orgSubject(subject, { organizationId: c.ctx.organizationId, createdById: c.ctx.userId });
    if (defineAbilityFor(c.ctx).cannot(action, target)) throw new ForbiddenError();
    return c;
  };

  await app.register(async (s) => {
    registerDomainErrorHandler(s);
    s.addHook('onRequest', g.mutationGuard);

    s.get<{ Params: NotificationOrgParams; Querystring: ListNotificationsQuery }>(
      NOTIFICATION_PATHS.notifications,
      {
        schema: {
          tags: ['notifications'],
          summary: "List the caller's notifications (newest first)",
          params: NotificationOrgParams,
          querystring: ListNotificationsQuery,
          response: { 200: NotificationList, ...directoryErrors },
        },
      },
      async (request) => {
        const c = await self(request, request.params.organizationId, 'read', 'Notification');
        return repo.list(c.ctx.organizationId, c.ctx.userId, request.query);
      },
    );

    s.post<{ Params: NotificationParams }>(
      NOTIFICATION_PATHS.markRead,
      {
        schema: {
          tags: ['notifications'],
          summary: 'Mark one of the caller notifications read',
          description: 'Idempotent: `updated` is 0 when it was already read or is not the caller notification.',
          params: NotificationParams,
          response: { 200: MarkNotificationsReadResponse, ...directoryErrors },
        },
      },
      async (request) => {
        const c = await self(request, request.params.organizationId, 'update', 'Notification');
        return {
          updated: await repo.markRead(c.ctx.organizationId, c.ctx.userId, [request.params.notificationId]),
        };
      },
    );

    s.post<{ Params: NotificationOrgParams }>(
      NOTIFICATION_PATHS.markAllRead,
      {
        schema: {
          tags: ['notifications'],
          summary: 'Mark all of the caller notifications read',
          params: NotificationOrgParams,
          response: { 200: MarkNotificationsReadResponse, ...directoryErrors },
        },
      },
      async (request) => {
        const c = await self(request, request.params.organizationId, 'update', 'Notification');
        return { updated: await repo.markRead(c.ctx.organizationId, c.ctx.userId, 'all') };
      },
    );

    s.get<{ Params: NotificationOrgParams }>(
      NOTIFICATION_PATHS.preferences,
      {
        schema: {
          tags: ['notifications'],
          summary: "The caller's notification preferences (absent = product default)",
          params: NotificationOrgParams,
          response: { 200: NotificationPreferences, ...directoryErrors },
        },
      },
      async (request) => {
        const c = await self(request, request.params.organizationId, 'read', 'NotificationPreference');
        return { items: await repo.getPreferences(c.ctx.organizationId, c.ctx.userId) };
      },
    );

    s.put<{ Params: NotificationOrgParams; Body: UpdateNotificationPreferencesRequest }>(
      NOTIFICATION_PATHS.preferences,
      {
        schema: {
          tags: ['notifications'],
          summary: 'Upsert notification preferences',
          params: NotificationOrgParams,
          body: UpdateNotificationPreferencesRequest,
          response: { 200: NotificationPreferences, ...directoryErrors },
        },
      },
      async (request) => {
        const c = await self(request, request.params.organizationId, 'update', 'NotificationPreference');
        return { items: await repo.setPreferences(c.ctx.organizationId, c.ctx.userId, request.body.items) };
      },
    );

    /** /me routes: the organization is the session's active one (never client input), so forced RLS applies. */
    const meCaller = async (request: FastifyRequest, action: 'create' | 'delete') => {
      const session = await g.requireSession(request);
      const organizationId = session.session.activeOrganizationId;
      if (!organizationId) throw new OrganizationNotFoundError();
      return self(request, organizationId, action, 'PushDevice', session);
    };

    s.post<{ Body: RegisterPushDeviceRequest }>(
      NOTIFICATION_PATHS.pushDevices,
      {
        schema: {
          tags: ['notifications'],
          summary: 'Register (or refresh) a push device for the caller',
          description:
            'Expo push tokens (ExponentPushToken[...] / ExpoPushToken[...]) for iOS/Android, or a Web Push subscription on an allowlisted push-service host for web/extension. Bound to the active organization; stored encrypted and never returned.',
          body: RegisterPushDeviceRequest,
          response: { 201: PushDevice, ...directoryWriteErrors, 503: ErrorBody },
        },
      },
      async (request, reply) => {
        const c = await meCaller(request, 'create');
        let token: string;
        try {
          token = pushTokenFromRegistration(request.body);
        } catch (e) {
          if (e instanceof PushTargetRejectedError) throw new PushTargetInvalidError();
          throw e;
        }
        const d = await repo.registerDevice(c.ctx.organizationId, c.ctx.userId, {
          platform: request.body.platform,
          token,
          label: request.body.deviceName ?? null,
        });
        return reply.status(201).send(d);
      },
    );

    s.delete<{ Params: PushDeviceParams }>(
      NOTIFICATION_PATHS.pushDevice,
      {
        schema: {
          tags: ['notifications'],
          summary: "Unregister one of the caller's push devices (idempotent)",
          params: PushDeviceParams,
          response: { 204: Type.Null(), ...directoryErrors },
        },
      },
      async (request, reply) => {
        const c = await meCaller(request, 'delete');
        await repo.unregisterDevice(c.ctx.organizationId, c.ctx.userId, request.params.id);
        return reply.status(204).send();
      },
    );
  });

  await app.register(async (s) => {
    registerDomainErrorHandler(s);
    // RFC 8058 one-click POSTs `List-Unsubscribe=One-Click` as a form; the body is ignored, the token is in the URL.
    s.addContentTypeParser('application/x-www-form-urlencoded', (_req, _body, done) => done(null, {}));
    const verify = (token: string) => {
      if (!linkSecret) throw new NotificationsUnavailableError('Email links');
      return verifyEmailLinkToken(linkSecret, token, 'unsubscribe');
    };

    s.get<{ Querystring: UnsubscribeQuery }>(
      NOTIFICATION_PATHS.unsubscribe,
      {
        schema: {
          tags: ['notifications'],
          summary: 'Unsubscribe confirm page (does not change anything)',
          querystring: UnsubscribeQuery,
          response: { 400: ErrorBody, 503: ErrorBody },
        },
      },
      async (request, reply) => {
        const ok = verify(request.query.token) !== null;
        return reply
          .status(ok ? 200 : 400)
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .header('referrer-policy', 'no-referrer')
          .header('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'")
          .send(ok ? unsubscribeConfirmPage(request.query.token) : '<!doctype html><p>This link is invalid or has expired.</p>');
      },
    );

    s.post<{ Querystring: UnsubscribeQuery }>(
      NOTIFICATION_PATHS.unsubscribe,
      {
        schema: {
          tags: ['notifications'],
          summary: 'Apply an unsubscribe link (email channel, link category)',
          querystring: UnsubscribeQuery,
          response: { 200: UnsubscribeResponse, 400: ErrorBody, 503: ErrorBody },
        },
      },
      async (request) => {
        const claims = verify(request.query.token);
        if (!claims) throw new UnsubscribeLinkInvalidError();
        await repo.setPreferences(claims.organizationId, claims.userId, [
          { type: claims.category === '*' ? '*' : claims.category.replace(/[^a-z0-9_.-]/g, '-').slice(0, 64), channel: 'email', enabled: false },
        ]);
        return { unsubscribed: true as const };
      },
    );
  });
}
