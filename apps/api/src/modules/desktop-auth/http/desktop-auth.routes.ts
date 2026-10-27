import type { FastifyInstance } from 'fastify';
import {
  DESKTOP_AUTH_PATHS,
  DesktopAuthorizeRequest,
  DesktopAuthorizeResponse,
  DesktopRefreshRequest,
  DesktopRefreshResponse,
  DesktopRevokeRequest,
  DesktopRevokeResponse,
  DesktopSwitchOrgRequest,
  DesktopSwitchOrgResponse,
  DesktopTokenRequest,
  DesktopTokenResponse,
} from '@meetops/contracts';
import type { AuthService } from '../../auth/application/auth.service.js';
import { UnauthenticatedError } from '../../auth/domain/errors.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from '../../auth/http/security.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import type { DesktopAuthService } from '../application/desktop-auth.service.js';

export interface DesktopAuthRoutesOptions {
  auth: AuthService;
  desktopAuth: DesktopAuthService;
  security: HttpSecurityConfig;
}

const tags = ['desktop-auth'];
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 429: ErrorBody };

/**
 * ADR-012 desktop token lifecycle. Registered only when DESKTOP_AUTH_ENABLED=true (default off while the ADR-012
 * amendment, PR #192, awaits sign-off). `authorize` is a web route (cookie + CSRF). The others are called by the
 * desktop app's Rust side: no CORS (no browser origin), a session cookie is rejected (401), Authorization is ignored.
 */
export async function desktopAuthRoutes(app: FastifyInstance, opts: DesktopAuthRoutesOptions) {
  registerDomainErrorHandler(app);
  const { auth, desktopAuth, security } = opts;
  const g = makeGuards(auth, security);
  const appPaths = new Set<string>([
    DESKTOP_AUTH_PATHS.token,
    DESKTOP_AUTH_PATHS.refresh,
    DESKTOP_AUTH_PATHS.revoke,
    DESKTOP_AUTH_PATHS.switchOrg,
  ]);

  app.addHook('onRequest', async (request) => {
    if (!appPaths.has(request.routeOptions.url ?? '')) return;
    if (request.cookies[security.cookieName]) throw new UnauthenticatedError();
  });

  app.post<{ Body: DesktopAuthorizeRequest }>(
    DESKTOP_AUTH_PATHS.authorize,
    {
      preHandler: g.mutationGuard,
      schema: {
        tags,
        summary: 'Authorize the desktop app (PKCE)',
        description:
          'Web route: session cookie + X-CSRF-Token. Returns a single-use authorization code (60 s) bound to the PKCE S256 challenge, the exact loopback redirect URI, the device id, user and active organization.',
        body: DesktopAuthorizeRequest,
        response: { 200: DesktopAuthorizeResponse, ...errors },
      },
    },
    async (request, reply) => {
      const { user, session } = await g.requireSession(request);
      void reply.header('cache-control', 'no-store');
      return desktopAuth.authorize(
        { userId: user.id, activeOrganizationId: session.activeOrganizationId },
        request.body,
        requestMeta(request),
      );
    },
  );

  app.post<{ Body: DesktopTokenRequest }>(
    DESKTOP_AUTH_PATHS.token,
    {
      schema: {
        tags,
        summary: 'Exchange an authorization code + PKCE verifier for desktop tokens',
        description:
          'Desktop route (no cookie). Consumes the code on any attempt; verifier, redirect URI and device id must match. 401 on any mismatch.',
        body: DesktopTokenRequest,
        response: { 200: DesktopTokenResponse, ...errors },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return desktopAuth.exchange(request.body, requestMeta(request));
    },
  );

  app.post<{ Body: DesktopRefreshRequest }>(
    DESKTOP_AUTH_PATHS.refresh,
    {
      schema: {
        tags,
        summary: 'Rotate desktop tokens',
        description:
          'Desktop route. Consumes the refresh token; a reused refresh token revokes the whole device family.',
        body: DesktopRefreshRequest,
        response: { 200: DesktopRefreshResponse, ...errors },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return desktopAuth.refresh(request.body, requestMeta(request));
    },
  );

  app.post<{ Body: DesktopRevokeRequest }>(
    DESKTOP_AUTH_PATHS.revoke,
    {
      schema: {
        tags,
        summary: 'Revoke this desktop device',
        description:
          'Desktop route. Authenticated by the refresh token; revokes the family. Idempotent.',
        body: DesktopRevokeRequest,
        response: { 200: DesktopRevokeResponse, ...errors },
      },
    },
    async (request) => desktopAuth.revoke(request.body, requestMeta(request)),
  );

  app.post<{ Body: DesktopSwitchOrgRequest }>(
    DESKTOP_AUTH_PATHS.switchOrg,
    {
      schema: {
        tags,
        summary: 'Switch the desktop session to another organization',
        description:
          'Desktop route. Consumes the refresh token, requires a live membership in the target org (else 404), revokes the old family and issues a new one.',
        body: DesktopSwitchOrgRequest,
        response: { 200: DesktopSwitchOrgResponse, ...errors },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return desktopAuth.switchOrg(request.body, requestMeta(request));
    },
  );
}
