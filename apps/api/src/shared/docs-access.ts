import type { FastifyInstance } from 'fastify';
import {
  SessionVerifier,
  type SessionVerifierDeps,
} from '../modules/auth/application/session-verifier.js';
import { UnauthenticatedError } from '../modules/auth/domain/errors.js';
import { ForbiddenError } from '../modules/organizations/domain/errors.js';

/**
 * Operator allowlist for Swagger UI outside development|test (API_DOCS_ADMIN_EMAILS, comma-separated, case-insensitive).
 * Org roles are not used: any user can create an organization and become its owner, so "org admin" proves nothing
 * about the deployment. Empty / unset = nobody (fails closed).
 */
export function docsAdminEmailsFromEnv(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
}

const readCookie = (header: string | undefined, name: string): string | undefined => {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim()) || undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

/**
 * #404 D2: when Swagger UI is enabled outside development|test (API_DOCS_ENABLED=true), every `/docs` request
 * (UI, static assets, /docs/json) needs an authenticated browser session (sid cookie; bearers are not accepted)
 * whose user is on the API_DOCS_ADMIN_EMAILS allowlist: 401 without a valid session, 403 otherwise. Registered
 * on the root instance before the Swagger UI plugin, so it runs ahead of its routes.
 */
export function registerDocsAccessGuard(
  app: FastifyInstance,
  opts: { deps: SessionVerifierDeps; cookieName: string; adminEmails: ReadonlySet<string> },
) {
  const verifier = new SessionVerifier(opts.deps);
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (path !== '/docs' && !path.startsWith('/docs/')) return;
    const session = await verifier
      .verify(readCookie(request.headers.cookie, opts.cookieName))
      .catch(() => null);
    if (!session) throw new UnauthenticatedError();
    const user = await opts.deps.users.findById(session.userId).catch(() => null);
    if (!user || user.deletedAt || !opts.adminEmails.has(user.email.trim().toLowerCase()))
      throw new ForbiddenError();
  });
}
