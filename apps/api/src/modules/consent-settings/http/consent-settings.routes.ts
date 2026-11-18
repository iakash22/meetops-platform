import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import {
  ConsentSettings,
  CONSENT_UPLOAD_PATHS,
  Id,
  UpdateConsentSettingsRequest,
} from '@meetops/contracts';
import type { AuthService } from '../../auth/application/auth.service.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from '../../auth/http/security.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import type { RouteLimiter } from '../../../shared/rate-limits.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { DirectoryAccess } from '../../directory/access.js';
import { directoryErrors } from '../../directory/http/route-kit.js';
import type { AuditLog } from '../../auth/domain/audit.js';
import { ConsentSettingsService } from '../application/consent-settings.service.js';
import type { ConsentSettingsRepository } from '../domain/consent-settings.js';

const tags = ['consent-settings'];
const errors = { ...directoryErrors } as const;

const ConsentSettingsParams = Type.Object({ organizationId: Id }, { additionalProperties: false });
type ConsentSettingsParams = Static<typeof ConsentSettingsParams>;

export interface ConsentSettingsPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  security: HttpSecurityConfig;
  audit: AuditLog;
  settings: ConsentSettingsRepository;
  now: () => Date;
  /** ROUTE_RATE_LIMITS.consentSettingsWrite (PATCH). */
  routeLimits?: RouteLimiter;
}

export async function consentSettingsRoutes(
  app: FastifyInstance,
  opts: ConsentSettingsPluginOptions,
) {
  registerDomainErrorHandler(app);
  const g = makeGuards(opts.auth, opts.security);
  app.addHook('onRequest', g.mutationGuard);
  const access = new DirectoryAccess(opts.organizations, opts.audit);
  const service = new ConsentSettingsService({
    settings: opts.settings,
    audit: opts.audit,
    now: opts.now,
  });

  app.get<{ Params: ConsentSettingsParams }>(
    CONSENT_UPLOAD_PATHS.consentSettings,
    {
      schema: {
        tags,
        summary: 'Organization consent and retention settings',
        description:
          'All roles. Returns stored settings, or ADR-019/020 defaults (explicit consent on, 90-day retention) when none exist.',
        params: ConsentSettingsParams,
        response: { 200: ConsentSettings, ...errors },
      },
    },
    async (request, reply) => {
      const c = await access.caller(
        await g.requireSession(request),
        request.params.organizationId,
        requestMeta(request),
      );
      return reply.header('cache-control', 'no-store').send(await service.get(c));
    },
  );

  app.patch<{ Params: ConsentSettingsParams; Body: UpdateConsentSettingsRequest }>(
    CONSENT_UPLOAD_PATHS.consentSettings,
    {
      schema: {
        tags,
        summary: 'Update organization consent and retention settings',
        description:
          'Owner or admin. Partial body (at least one field). CSRF and audit-logged. Changing noticeText bumps currentConsentVersion.',
        params: ConsentSettingsParams,
        body: UpdateConsentSettingsRequest,
        response: { 200: ConsentSettings, ...errors },
      },
    },
    async (request) => {
      const c = await access.caller(
        await g.requireSession(request),
        request.params.organizationId,
        requestMeta(request),
      );
      return service.update(c, request.body);
    },
  );
}
