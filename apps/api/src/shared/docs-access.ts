import type { FastifyInstance, FastifyRequest } from 'fastify';
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

const DOCS_PREFIX = '/docs';
const isDocsPath = (p: string | undefined): boolean =>
  p !== undefined && (p === DOCS_PREFIX || p.startsWith(`${DOCS_PREFIX}/`));

/**
 * Canonical form of a raw request path for the docs check: percent-decoded (repeatedly, so double encoding
 * cannot hide `/docs`), lowercased, backslashes as slashes, duplicate slashes collapsed. Undecodable input
 * returns null so the caller fails closed.
 */
export function normalizeDocsPath(rawUrl: string): string | null {
  let p = rawUrl.split('?')[0] ?? '';
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (next === p) break;
    p = next;
  }
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/**
 * True when a request targets Swagger UI. Matches on the router's resolved route pattern
 * (request.routeOptions.url, e.g. `/docs/json`, `/docs/static/*`), which the router produces after decoding,
 * so `/%64ocs/json` resolves to `/docs/json`. The normalized raw path is checked too, so case, double-encoded
 * and slash variants that do not resolve to a route still get a 401 rather than leaking existence.
 */
export function isDocsRequest(request: FastifyRequest): boolean {
  if (isDocsPath(request.routeOptions?.url)) return true;
  const normalized = normalizeDocsPath(request.url);
  return normalized === null || isDocsPath(normalized);
}

/**
 * #404 D2: when Swagger UI is enabled outside development|test (API_DOCS_ENABLED=true), every `/docs` request
 * (UI, static assets, /docs/json, /docs/yaml) needs an authenticated browser session (sid cookie; bearers are
 * not accepted) whose user is on the API_DOCS_ADMIN_EMAILS allowlist: 401 without a valid session, 403
 * otherwise. Returns the hook so server.ts can also pass it as swagger-ui `uiHooks.onRequest`; it is
 * registered on the root instance as well because @fastify/static asset routes do not receive uiHooks.
 */
export function createDocsAccessHook(opts: {
  deps: SessionVerifierDeps;
  cookieName: string;
  adminEmails: ReadonlySet<string>;
}) {
  const verifier = new SessionVerifier(opts.deps);
  return async (request: FastifyRequest): Promise<void> => {
    const session = await verifier
      .verify(readCookie(request.headers.cookie, opts.cookieName))
      .catch(() => null);
    if (!session) throw new UnauthenticatedError();
    const user = await opts.deps.users.findById(session.userId).catch(() => null);
    if (!user || user.deletedAt || !opts.adminEmails.has(user.email.trim().toLowerCase()))
      throw new ForbiddenError();
  };
}

export function registerDocsAccessGuard(
  app: FastifyInstance,
  opts: { deps: SessionVerifierDeps; cookieName: string; adminEmails: ReadonlySet<string> },
) {
  const check = createDocsAccessHook(opts);
  app.addHook('onRequest', async (request) => {
    if (!isDocsRequest(request)) return;
    await check(request);
  });
  return check;
}
