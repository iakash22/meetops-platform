import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EXTENSION_AUTH_PATHS,
  ExtensionPairRequest,
  ExtensionPairResponse,
  ExtensionRefreshRequest,
  ExtensionRefreshResponse,
  ExtensionRevokeRequest,
  ExtensionRevokeResponse,
  ExtensionTokenRequest,
  ExtensionTokenResponse,
} from '@meetops/contracts';
import type { AuthService } from '../../auth/application/auth.service.js';
import { UnauthenticatedError } from '../../auth/domain/errors.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from '../../auth/http/security.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import type { ExtensionAuthService } from '../application/extension-auth.service.js';

export interface ExtensionAuthRoutesOptions {
  auth: AuthService;
  extensionAuth: ExtensionAuthService;
  security: HttpSecurityConfig;
}

const tags = ['extension-auth'];
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 429: ErrorBody };

/**
 * ADR-005 amendment 1 token lifecycle. `pair` is a web route (cookie + CSRF). `extension-token`, `refresh` and
 * `revoke` are called by the extension: they ignore `Authorization`, reject a session cookie (401), and get CORS
 * for the allowlisted `chrome-extension://<id>` origins only, never with credentials (A1.3.6).
 */
export async function extensionAuthRoutes(app: FastifyInstance, opts: ExtensionAuthRoutesOptions) {
  registerDomainErrorHandler(app);
  const { auth, extensionAuth, security } = opts;
  const g = makeGuards(auth, security);
  const extensionPaths = new Set<string>([
    EXTENSION_AUTH_PATHS.token,
    EXTENSION_AUTH_PATHS.refresh,
    EXTENSION_AUTH_PATHS.revoke,
  ]);

  const cors = (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (!origin || !extensionAuth.allowedOrigins().includes(origin)) return false;
    void reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
    return true;
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!extensionPaths.has(request.routeOptions.url ?? '')) return;
    cors(request, reply);
    if (request.method === 'OPTIONS') return;
    // A1.3.1: lifecycle routes never accept the web session cookie.
    if (request.cookies[security.cookieName]) throw new UnauthenticatedError();
  });

  for (const path of extensionPaths) {
    app.options(path, { schema: { hide: true } }, async (request, reply) => {
      if (cors(request, reply)) {
        void reply
          .header('access-control-allow-methods', 'POST')
          .header('access-control-allow-headers', 'content-type')
          .header('access-control-max-age', '600');
      }
      return reply.status(204).send();
    });
  }

  app.post<{ Body: ExtensionPairRequest }>(
    EXTENSION_AUTH_PATHS.pair,
    {
      preHandler: g.mutationGuard,
      schema: {
        tags,
        summary: 'Start extension pairing',
        description:
          'Web route: session cookie + X-CSRF-Token. Returns a single-use pairing code (60 s) bound to the nonce, extension id, device id, user and active organization. Carries no tokens.',
        body: ExtensionPairRequest,
        response: { 200: ExtensionPairResponse, ...errors },
      },
    },
    async (request, reply) => {
      const { user, session } = await g.requireSession(request);
      void reply.header('cache-control', 'no-store');
      return extensionAuth.pair(
        { userId: user.id, activeOrganizationId: session.activeOrganizationId },
        request.body,
        requestMeta(request),
      );
    },
  );

  app.post<{ Body: ExtensionTokenRequest }>(
    EXTENSION_AUTH_PATHS.token,
    {
      schema: {
        tags,
        summary: 'Exchange a pairing code for extension tokens',
        description:
          'Extension route (no cookie). Consumes the pairing code atomically; nonce, extension id and device id must match. 401 on any mismatch.',
        body: ExtensionTokenRequest,
        response: { 200: ExtensionTokenResponse, ...errors },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return extensionAuth.exchange(request.body, requestMeta(request));
    },
  );

  app.post<{ Body: ExtensionRefreshRequest }>(
    EXTENSION_AUTH_PATHS.refresh,
    {
      schema: {
        tags,
        summary: 'Rotate extension tokens',
        description:
          'Extension route (no cookie, no Bearer). Consumes the refresh token; a reused refresh token revokes the whole device family.',
        body: ExtensionRefreshRequest,
        response: { 200: ExtensionRefreshResponse, ...errors },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return extensionAuth.refresh(request.body, requestMeta(request));
    },
  );

  app.post<{ Body: ExtensionRevokeRequest }>(
    EXTENSION_AUTH_PATHS.revoke,
    {
      schema: {
        tags,
        summary: 'Revoke this extension device',
        description:
          'Extension route (no cookie, no Bearer). Authenticated by the refresh token; revokes the device family. Idempotent.',
        body: ExtensionRevokeRequest,
        response: { 200: ExtensionRevokeResponse, ...errors },
      },
    },
    async (request) => extensionAuth.revoke(request.body, requestMeta(request)),
  );
}
