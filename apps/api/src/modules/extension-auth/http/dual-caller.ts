import type { FastifyRequest } from 'fastify';
import type { ExtensionScope } from '@meetops/contracts';
import type { DirectoryCaller } from '../../directory/access.js';
import type { ResolveCaller } from '../../directory/http/route-kit.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { requestMeta } from '../../auth/http/security.js';
import type { VerifiedSession } from '../../auth/application/session-verifier.js';

export type ExtensionBearerGuard = (
  request: FastifyRequest,
  scope: ExtensionScope,
  organizationId: string,
) => Promise<VerifiedSession>;

/** True when the request presents an `Authorization: Bearer` header (any value; the guard validates it). */
export const hasBearer = (request: FastifyRequest): boolean =>
  /^Bearer\s/i.test(request.headers.authorization ?? '');

/**
 * CSRF/origin protection is for ambient cookie credentials. A request that sends a Bearer header is routed to the
 * bearer guard, which rejects any request that also carries a session cookie (ADR-005 A1.3.1), so skipping the cookie
 * CSRF check for it is safe. Everything else keeps the normal mutation guard.
 */
export function bearerAwareMutationGuard(
  mutationGuard: (request: FastifyRequest) => Promise<void>,
): (request: FastifyRequest) => Promise<void> {
  return async (request) => {
    if (hasBearer(request)) return;
    await mutationGuard(request);
  };
}

/**
 * ADR-005 extension routes, used by web/mobile with the session cookie and by the extension with a bearer token.
 * A Bearer header selects the bearer path (cookie present -> 401, bad token -> 401, other org -> 404, missing
 * scope -> 403, then live membership via resolveTenant); otherwise the cookie caller runs unchanged.
 */
export function dualCaller(
  cookieCaller: ResolveCaller,
  guard: ExtensionBearerGuard | undefined,
  organizations: OrganizationService,
  scope: ExtensionScope,
): ResolveCaller {
  if (!guard) return cookieCaller;
  return async (request, organizationId): Promise<DirectoryCaller> => {
    if (!hasBearer(request)) return cookieCaller(request, organizationId);
    const v = await guard(request, scope, organizationId);
    const ctx = await organizations.resolveTenant(organizationId, v.userId);
    return { ctx, meta: requestMeta(request) };
  };
}

/**
 * Session-scoped routes have no org in the path. Cookie callers use their active org; a bearer caller uses the
 * token's org (the guard is then a tautological org match but still enforces cookie rejection and scope).
 */
export function dualActiveCaller(
  cookieActiveCaller: (request: FastifyRequest) => Promise<DirectoryCaller>,
  guard: ExtensionBearerGuard | undefined,
  verifyOrg: (request: FastifyRequest) => Promise<string>,
  bearerCaller: ResolveCaller,
): (request: FastifyRequest) => Promise<DirectoryCaller> {
  if (!guard) return cookieActiveCaller;
  return async (request) => {
    if (!hasBearer(request)) return cookieActiveCaller(request);
    return bearerCaller(request, await verifyOrg(request));
  };
}
