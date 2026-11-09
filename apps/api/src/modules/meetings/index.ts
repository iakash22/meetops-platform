import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import { routeLimiter } from '../../shared/rate-limits.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { DirectoryAccess } from '../directory/access.js';
import type { ResolveCaller } from '../directory/http/route-kit.js';
import type { ModuleDeps } from '../index.js';
import { MeetingService } from './application/meeting.service.js';
import { meetingRoutes } from './http/meetings.routes.js';
import {
  bearerAwareMutationGuard,
  dualCaller,
  type ExtensionBearerGuard,
} from '../extension-auth/http/dual-caller.js';

export interface MeetingsPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  deps: ModuleDeps;
  /** ADR-005 bearer guard; when set, `meetings/resolve` also accepts an extension token (`meetings:resolve`). */
  extensionBearer?: ExtensionBearerGuard;
}

/**
 * Meetings module: list, detail and resolve under `/orgs/:organizationId/meetings`. Same tenancy gate as the
 * directory: session (401) -> path org is the active org and the caller a member, else 404 -> CASL (403).
 */
export default async function meetingsModule(app: FastifyInstance, opts: MeetingsPluginOptions) {
  const { auth, organizations, deps } = opts;
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  app.addHook(
    'onRequest',
    bearerAwareMutationGuard(g.mutationGuard, {
      cookieName: deps.security.cookieName,
      bearerEnabled: opts.extensionBearer !== undefined,
    }),
  );
  const access = new DirectoryAccess(organizations, deps.audit);
  const caller: ResolveCaller = async (request, organizationId) =>
    access.caller(await g.requireSession(request), organizationId, requestMeta(request));
  await app.register(meetingRoutes, {
    meetings: new MeetingService(deps.meetings, access, organizations, deps.rateLimiter),
    caller,
    resolveCaller: dualCaller(caller, opts.extensionBearer, organizations, 'meetings:resolve'),
    routeLimits: routeLimiter(deps.rateLimiter, deps.routeRateLimits),
  });
}
