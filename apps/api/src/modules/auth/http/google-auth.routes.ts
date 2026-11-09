import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from '../application/auth.service.js';
import {
  GoogleTokenError,
  OAUTH_STATE_TTL_MS,
  GOOGLE_VERIFY_LINK_TTL_MS,
  PENDING_LINK_TTL_MS,
  SIGNUP_BINDING_TTL_MS,
  deriveOAuthStateKey,
  googleAuthorizeUrl,
  newOAuthState,
  openOAuthState,
  safeNext,
  sealOAuthState,
  sealPendingLink,
  type GoogleOAuthConfig,
} from '../application/google-oidc.js';
import { createGoogleOAuthClient, type GoogleOAuthClient } from '../application/google-oauth.js';
import { RateLimitedError } from '../domain/errors.js';
import { RateLimiterUnavailableError } from '../../../shared/rate-limit-core.js';
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

/**
 * M-2: `<oauth state cookie>_link` (so `__Host-meetops_oauth_link` outside development) holds a sealed
 * `{ userId, sub }` for ten minutes after a callback that needs the account's password before linking. HttpOnly,
 * SameSite=Lax, path /; its HMAC key is HKDF(CSRF_SECRET, info "oauth-link"), separate from the state key.
 */
export function pendingLinkCookie(security: HttpSecurityConfig) {
  return {
    name: `${security.oauthStateCookieName}_link`,
    key: deriveOAuthStateKey(security.csrfSecret, 'oauth-link'),
    attributes: {
      secure: security.cookieSecure,
      sameSite: 'lax' as const,
      path: '/',
      httpOnly: true,
    },
  };
}

/**
 * OIDC review N-7: an unproven Google subject waiting, in the browser that signed in, for the verification link to be
 * opened in that browser's session. HttpOnly, Lax, own HKDF key.
 */
export function verifyLinkCookie(security: HttpSecurityConfig) {
  return {
    name: `${security.oauthStateCookieName}_vlink`,
    key: deriveOAuthStateKey(security.csrfSecret, 'oauth-verify-link'),
    maxAgeS: Math.floor(GOOGLE_VERIFY_LINK_TTL_MS / 1000),
    attributes: {
      secure: security.cookieSecure,
      sameSite: 'lax' as const,
      path: '/',
      httpOnly: true,
    },
  };
}

/**
 * OIDC review N-1 residual: marks the browser that registered a password account (see AuthService.verifyEmail).
 * HttpOnly, Strict (only the app's own fetches need it), own HKDF key; carries no secret, only the account id.
 */
export function signupBindingCookie(security: HttpSecurityConfig) {
  return {
    name: `${security.cookieName}_signup`,
    key: deriveOAuthStateKey(security.csrfSecret, 'signup-binding'),
    maxAgeS: Math.floor(SIGNUP_BINDING_TTL_MS / 1000),
    attributes: {
      secure: security.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
      httpOnly: true,
    },
  };
}

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

  // L-4: the state cookie's MAC key is derived from CSRF_SECRET, never CSRF_SECRET itself.
  const stateKey = deriveOAuthStateKey(security.csrfSecret);
  const pendingLink = pendingLinkCookie(security);
  const verifyLink = verifyLinkCookie(security);

  const home = () => appOrigin(opts.webBaseUrl, security.allowedOrigins);

  const sendApp = (reply: FastifyReply, pathAndQuery: string) => {
    const origin = home();
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    if (!origin) return reply.code(500).type('text/plain').send('Sign-in is unavailable');
    return reply.redirect(new URL(pathAndQuery, origin).toString());
  };

  const fail = (
    reply: FastifyReply,
    error: 'google' | 'google_unverified' | 'google_link_password',
    next: string,
  ) => {
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
          'Sets a 10-minute HttpOnly state cookie (PKCE verifier, nonce, state) and redirects to Google. Sign-up and log-in share this flow. This is where the per-IP Google budget is charged (once per flow).',
        querystring: startQuery,
      },
    },
    async (request, reply) => {
      if (!opts.google || !client || !home()) return reply.status(404).send();
      const next = safeNext(request.query.next);
      try {
        await auth.enforceGoogleRateLimit(requestMeta(request).ip);
      } catch (e) {
        if (e instanceof RateLimitedError || e instanceof RateLimiterUnavailableError)
          return fail(reply, 'google', next);
        throw e;
      }
      const flow = newOAuthState(next, Date.now());
      reply.setCookie(security.oauthStateCookieName, sealOAuthState(flow, stateKey), {
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
          'Checks the one-time state cookie (refused before any rate-limit charge when missing or invalid; each state completes one callback), exchanges the code with PKCE, verifies the ID token, sets the session cookie, and redirects to the web app. An existing verified account whose email Google does not prove (not gmail.com/googlemail.com and no matching Workspace hd) is not auto-linked: the browser lands on /login?error=google_link_password with a 10-minute pending-link cookie, and the next password login of that account links Google.',
        querystring: callbackQuery,
      },
    },
    async (request, reply) => {
      if (!opts.google || !client || !home()) return reply.status(404).send();
      const sealed = openOAuthState(
        request.cookies[security.oauthStateCookieName],
        request.query.state,
        stateKey,
        Date.now(),
      );
      reply.clearCookie(security.oauthStateCookieName, stateCookie);
      const meta = requestMeta(request);
      const next = sealed?.next ?? '/';
      // N-3: a missing, forged or expired cookie is refused before anything is charged or fetched. The per-IP budget
      // was charged once, by /start, for this flow; here each sealed state may complete a single callback.
      if (!sealed) return fail(reply, 'google', next);
      try {
        await auth.consumeGoogleFlow(
          createHash('sha256').update(sealed.state).digest('base64url'),
          OAUTH_STATE_TTL_MS,
        );
        if (request.query.error || !request.query.code) return fail(reply, 'google', next);
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
        if (outcome.kind === 'link_required') {
          reply.setCookie(
            pendingLink.name,
            sealPendingLink(
              {
                uid: outcome.pending.userId,
                sub: outcome.pending.sub,
                exp: Date.now() + PENDING_LINK_TTL_MS,
              },
              pendingLink.key,
            ),
            { ...pendingLink.attributes, maxAge: Math.floor(PENDING_LINK_TTL_MS / 1000) },
          );
          return fail(reply, 'google_link_password', next);
        }
        if (outcome.kind !== 'session') return fail(reply, 'google', next);
        if (outcome.verifyLink) {
          reply.setCookie(
            verifyLink.name,
            sealPendingLink(
              {
                uid: outcome.verifyLink.userId,
                sub: outcome.verifyLink.sub,
                exp: Date.now() + GOOGLE_VERIFY_LINK_TTL_MS,
              },
              verifyLink.key,
            ),
            { ...verifyLink.attributes, maxAge: verifyLink.maxAgeS },
          );
        }
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
