import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from '../application/auth.service.js';
import {
  GoogleTokenError,
  googleAuthorizeUrl,
  newOAuthState,
  openOAuthState,
  safeNext,
  sealOAuthState,
  type GoogleOAuthConfig,
} from '../application/google-oidc.js';
import { createGoogleOAuthClient, type GoogleOAuthClient } from '../application/google-oauth.js';
import { RateLimitedError } from '../domain/errors.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from './security.js';

export interface GoogleAuthOptions {
  auth: AuthService;
  security: HttpSecurityConfig;
  guards: ReturnType<typeof makeGuards>;
  /** Where the browser goes after Google. Its origin must be in WEB_ORIGINS. */
  webBaseUrl: string;
  google: { config: GoogleOAuthConfig; client?: GoogleOAuthClient } | null;
}

const providersBody = Type.Object({ google: Type.Boolean() }, { additionalProperties: false });
const startQuery = Type.Object(
  { next: Type.Optional(Type.String({ maxLength: 512 })) },
  { additionalProperties: false },
);
/** Google adds `scope`, `authuser`, `prompt`, and `hd`. Those must not 400 the callback. */
const callbackQuery = Type.Object(
  {
    code: Type.Optional(Type.String({ maxLength: 2048 })),
    state: Type.Optional(Type.String({ maxLength: 200 })),
    error: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: true },
);

function appOrigin(webBaseUrl: string, allowed: string[]): URL | null {
  try {
    const url = new URL(webBaseUrl);
    if (url.username || url.password) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!allowed.includes(url.origin)) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Full-page navigations. Failures redirect to /login with a fixed code.
 * The authorization code, ID token, verifier, and client secret never appear in that redirect.
 */
export function googleAuthRoutes(app: FastifyInstance, opts: GoogleAuthOptions) {
  const { auth, security, guards: g } = opts;
  const client = opts.google?.client ?? (opts.google ? createGoogleOAuthClient() : null);
  const stateCookie = {
    secure: security.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    httpOnly: true,
  };

  const home = () => appOrigin(opts.webBaseUrl, security.allowedOrigins);

  const sendApp = (reply: FastifyReply, pathAndQuery: string) => {
    const origin = home();
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    if (!origin) return reply.code(500).type('text/plain').send('Sign-in is unavailable');
    return reply.redirect(new URL(pathAndQuery, origin).toString());
  };

  const fail = (reply: FastifyReply, error: 'google' | 'google_unverified', next: string) => {
    const params = new URLSearchParams({ error });
    if (next !== '/') params.set('next', next);
    return sendApp(reply, `/login?${params.toString()}`);
  };

  app.get(
    '/auth/providers',
    {
      schema: {
        tags: ['auth'],
        summary: 'Which external sign-in providers are configured',
        description: 'Public. Booleans only. No client ids or secrets.',
        response: { 200: providersBody },
      },
    },
    async (_request, reply) => {
      void reply.header('cache-control', 'no-store');
      return { google: opts.google !== null };
    },
  );

  app.get<{ Querystring: { next?: string } }>(
    '/auth/google/start',
    {
      schema: {
        tags: ['auth'],
        summary: 'Start Google sign-in',
        description:
          'Sets a 10-minute HttpOnly state cookie (PKCE verifier, nonce, state) and redirects to Google. Sign-up and log-in share this flow.',
        querystring: startQuery,
      },
    },
    async (request, reply) => {
      if (!opts.google || !client || !home()) return reply.status(404).send();
      const next = safeNext(request.query.next);
      try {
        await auth.enforceGoogleRateLimit(requestMeta(request).ip);
      } catch (e) {
        if (e instanceof RateLimitedError) return fail(reply, 'google', next);
        throw e;
      }
      const flow = newOAuthState(next, Date.now());
      reply.setCookie(security.oauthStateCookieName, sealOAuthState(flow, security.csrfSecret), {
        ...stateCookie,
        maxAge: 600,
      });
      void reply.header('cache-control', 'no-store');
      void reply.header('referrer-policy', 'no-referrer');
      return reply.redirect(googleAuthorizeUrl(opts.google.config, flow));
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    {
      schema: {
        tags: ['auth'],
        summary: 'Google sign-in callback',
        description:
          'Checks the one-time state cookie, exchanges the code with PKCE, verifies the ID token, sets the session cookie, and redirects to the web app.',
        querystring: callbackQuery,
      },
    },
    async (request, reply) => {
      if (!opts.google || !client || !home()) return reply.status(404).send();
      const sealed = openOAuthState(
        request.cookies[security.oauthStateCookieName],
        request.query.state,
        security.csrfSecret,
        Date.now(),
      );
      reply.clearCookie(security.oauthStateCookieName, stateCookie);
      const meta = requestMeta(request);
      const next = sealed?.next ?? '/';
      try {
        await auth.enforceGoogleRateLimit(meta.ip);
        if (!sealed || request.query.error || !request.query.code)
          return fail(reply, 'google', next);
        const idToken = await client.exchangeCode({
          code: request.query.code,
          codeVerifier: sealed.verifier,
          config: opts.google.config,
        });
        const identity = await client.verifyIdToken(idToken, {
          audience: opts.google.config.clientId,
          nonce: sealed.nonce,
          now: new Date(),
        });
        const outcome = await auth.completeGoogleSignIn(identity, meta, g.readToken(request));
        if (outcome.kind === 'unverified_local') return fail(reply, 'google_unverified', next);
        if (outcome.kind !== 'session') return fail(reply, 'google', next);
        g.setSessionCookie(reply, outcome.result);
        g.issueCsrfForSession(reply, outcome.result.session.id);
        return sendApp(reply, next);
      } catch (e) {
        if (!(e instanceof RateLimitedError) && !(e instanceof GoogleTokenError)) {
          request.log.warn(
            { errName: e instanceof Error ? e.name : 'error' },
            'google sign-in failed',
          );
        }
        return fail(reply, 'google', next);
      }
    },
  );
}
