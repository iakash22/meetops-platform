import type { FastifyReply, FastifyRequest } from 'fastify';
import { CONSENT_UPLOAD_PATHS, RECORDING_SESSION_PATHS } from '@meetops/contracts';

/** meetings/resolve lives in the API meetings module (not in contracts MEETING_PATHS). */
const MEETINGS_RESOLVE_PATH = '/orgs/:organizationId/meetings/resolve';

/** Route templates that accept the ADR-005 extension bearer (see dual-caller.ts). */
export const EXTENSION_BEARER_ROUTE_TEMPLATES: readonly string[] = [
  MEETINGS_RESOLVE_PATH,
  RECORDING_SESSION_PATHS.init,
  RECORDING_SESSION_PATHS.chunks,
  RECORDING_SESSION_PATHS.complete,
  RECORDING_SESSION_PATHS.abort,
  CONSENT_UPLOAD_PATHS.uploads,
  CONSENT_UPLOAD_PATHS.uploadComplete,
];

const toRegex = (t: string) => new RegExp(`^${t.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
const BEARER_ROUTES = EXTENSION_BEARER_ROUTE_TEMPLATES.map(toRegex);

/** True when the request path (query stripped) is one of the bearer-enabled extension routes. */
export const isExtensionBearerPath = (url: string | undefined): boolean => {
  const path = (url ?? '').split('?')[0] ?? '';
  return BEARER_ROUTES.some((r) => r.test(path));
};

export const isExtensionOrigin = (origin: unknown): origin is string =>
  typeof origin === 'string' && origin.startsWith('chrome-extension://');

/**
 * ADR-005 A1.3.6 CORS for the bearer-enabled routes: only allowlisted `chrome-extension://<id>` origins, no
 * `Access-Control-Allow-Credentials`, request headers limited to `authorization` and `content-type`. Preflights are
 * answered here (204) so the credentialed web CORS never handles an extension-origin request on these routes.
 */
export function extensionBearerCorsHook(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (!isExtensionOrigin(origin) || !isExtensionBearerPath(request.url)) return;
    const ok = allowed.has(origin);
    void reply.header('vary', 'Origin');
    if (ok) void reply.header('access-control-allow-origin', origin);
    if (request.method !== 'OPTIONS') return;
    if (ok) {
      void reply
        .header('access-control-allow-methods', 'POST')
        .header('access-control-allow-headers', 'authorization, content-type')
        .header('access-control-max-age', '600');
    }
    return reply.status(204).send();
  };
}
