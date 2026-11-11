import type { GeoFields } from '../../../shared/geoip/provider.js';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from '../application/auth.service.js';
import { MfaRequiredError } from '../domain/errors.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import {
  AcceptedBody,
  CsrfBody,
  ErrorBody,
  ForgotPasswordBody,
  LoginBody,
  ResetPasswordBody,
  GetSessionResponse,
  SessionResponse,
  SignupBody,
  ResendVerificationBody,
  SessionIdParams,
  SessionList,
  VerifyEmailBody,
  type SessionIdParamsT,
  type VerifyEmailBodyT,
  type ForgotPasswordBodyT,
  type LoginBodyT,
  type ResetPasswordBodyT,
  type SignupBodyT,
} from './schemas.js';
import {
  capIp,
  capUserAgent,
  makeGuards,
  requestMeta,
  type HttpSecurityConfig,
} from './security.js';
import { CursorPageQuery } from '@meetops/contracts';
import { paginate } from '../../../shared/pagination.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { toSessionResponse } from './mappers.js';
import { toUserDto } from '../../users/http/mappers.js';
import {
  googleAuthRoutes,
  pendingLinkCookie,
  signupBindingCookie,
  verifyLinkCookie,
  type GoogleAuthOptions,
} from './google-auth.routes.js';
import {
  GOOGLE_VERIFY_LINK_TTL_MS,
  SIGNUP_BINDING_TTL_MS,
  openPendingLink,
  sealPendingLink,
} from '../application/google-oidc.js';

/** ADR-014 SessionSummary geo: optional, not nullable (unknown fields are omitted). */
function sessionGeo(g: GeoFields | undefined) {
  if (!g?.geoApproximate) return {};
  return {
    ...(g.geoCity ? { geoCity: g.geoCity } : {}),
    ...(g.geoRegion ? { geoRegion: g.geoRegion } : {}),
    ...(g.geoCountry ? { geoCountry: g.geoCountry } : {}),
    ...(g.geoCountryCode ? { geoCountryCode: g.geoCountryCode } : {}),
    geoApproximate: true as const,
  };
}

/**
 * UX-1: response header on POST /auth/verify-email, exposed to CORS callers. Values:
 * - `password_reset`: mailbox-owner takeover that removed the account's password; a set-password link was emailed;
 * - `set_password`: mailbox-owner takeover of an account that never had a password; a set-password link was emailed;
 * - `verified`: anything else.
 * TODO(contracts): move to @meetops/contracts with the next contracts minor bump (ADR-003: an additive export is a
 * MINOR); until then apps/web/src/lib/api/client.ts keeps an identical copy, pinned by tests on both sides.
 */
export const VERIFY_OUTCOME_HEADER = 'x-meetops-verify-outcome';
export const VERIFY_OUTCOMES = {
  passwordReset: 'password_reset',
  setPassword: 'set_password',
  verified: 'verified',
} as const;

export interface AuthPluginOptions {
  auth: AuthService;
  security: HttpSecurityConfig;
  organizations: OrganizationService;
  webBaseUrl: string;
  google: GoogleAuthOptions['google'];
}

const tags = ['auth'];
const SIGNUP_MSG = 'Check your email to continue.';
const RESET_MSG = 'If an account exists for that email, we sent a reset link.';

export async function authRoutes(app: FastifyInstance, opts: AuthPluginOptions) {
  registerDomainErrorHandler(app);
  const { auth, security } = opts;
  const g = makeGuards(auth, security);
  const pendingLink = pendingLinkCookie(security);
  const verifyLink = verifyLinkCookie(security);
  const signupBinding = signupBindingCookie(security);
  app.addHook('onRequest', g.mutationGuard);

  app.post<{ Body: SignupBodyT }>(
    '/auth/signup',
    {
      schema: {
        tags,
        summary: 'Create an account',
        description:
          'Enumeration-safe: always 202 with the same message whether or not the email exists. Does not start a session; log in afterwards. Sets an HttpOnly signup-binding cookie (same shape either way): verifying the email from this browser keeps the chosen password.',
        body: SignupBody,
        response: { 202: AcceptedBody, 400: ErrorBody, 403: ErrorBody, 429: ErrorBody },
      },
    },
    async (request, reply) => {
      const r = await auth.signup(request.body, requestMeta(request));
      reply.setCookie(
        signupBinding.name,
        sealPendingLink(
          { uid: r.binding, sub: '', exp: Date.now() + SIGNUP_BINDING_TTL_MS },
          signupBinding.key,
        ),
        { ...signupBinding.attributes, maxAge: signupBinding.maxAgeS },
      );
      return reply.status(202).send({ message: SIGNUP_MSG });
    },
  );

  app.post<{ Body: LoginBodyT }>(
    '/auth/login',
    {
      schema: {
        tags,
        summary: 'Log in',
        description:
          'Verifies credentials, revokes any presented session, sets a new httpOnly session cookie and a fresh CSRF cookie (also returned as csrfToken). With a pending Google link cookie from /auth/google/callback for this same verified account, links Google and signs out the other sessions. Generic 401 AUTH_FAILED on failure; 429 when rate-limited or locked. ADR-021: for a user with MFA on, the body is reduced and `mfaRequired` is true; finish with POST /auth/mfa/challenge.',
        body: LoginBody,
        response: { 200: SessionResponse, 401: ErrorBody, 403: ErrorBody, 429: ErrorBody },
      },
    },
    async (request, reply) => {
      // M-2: a Google subject parked by the callback is linked only after this password proves the account.
      const pending = openPendingLink(
        request.cookies[pendingLink.name],
        pendingLink.key,
        Date.now(),
      );
      const r = await auth.login(request.body, requestMeta(request), g.readToken(request), pending);
      if (request.cookies[pendingLink.name] !== undefined)
        reply.clearCookie(pendingLink.name, pendingLink.attributes);
      if ('mfaChallenge' in r) {
        // ADR-021 OQ-17: no session cookie. The body says mfaRequired; the CSRF token stays bound to the pre-session
        // so the same browser can POST /auth/mfa/challenge. Any old session cookie is cleared (it was revoked).
        void reply.header('cache-control', 'no-store');
        reply.clearCookie(security.cookieName, {
          secure: security.cookieSecure,
          sameSite: 'lax',
          path: '/',
          httpOnly: true,
        });
        g.setMfaChallengeCookie(reply, r.mfaChallenge);
        return {
          user: toUserDto(r.user),
          csrfToken: await g.issueCsrf(request, reply),
          activeOrganizationId: null,
          role: null,
          organizations: [],
          memberships: [],
          expiresAt: r.mfaChallenge.expiresAt.toISOString(),
          mfaRequired: true,
        };
      }
      g.clearMfaChallengeCookie(reply);
      g.setSessionCookie(reply, r);
      return {
        ...(await toSessionResponse(r, opts.organizations)),
        csrfToken: g.issueCsrfForSession(reply, r.session.id),
      };
    },
  );

  app.post<{ Body: ForgotPasswordBodyT }>(
    '/auth/forgot-password',
    {
      schema: {
        tags,
        summary: 'Request a password reset',
        description: 'Enumeration-safe: always 202 with the same message.',
        body: ForgotPasswordBody,
        response: { 202: AcceptedBody, 403: ErrorBody, 429: ErrorBody },
      },
    },
    async (request, reply) => {
      await auth.requestPasswordReset(request.body.email, requestMeta(request));
      return reply.status(202).send({ message: RESET_MSG });
    },
  );

  app.post<{ Body: ResetPasswordBodyT }>(
    '/auth/reset-password',
    {
      schema: {
        tags,
        summary: 'Reset password',
        description:
          'Consumes a single-use reset token (30 min TTL) and revokes all sessions for the user.',
        body: ResetPasswordBody,
        response: { 204: Type.Null(), 400: ErrorBody, 403: ErrorBody, 429: ErrorBody },
      },
    },
    async (request, reply) => {
      await auth.resetPassword(request.body, requestMeta(request));
      g.clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  app.get(
    '/auth/csrf',
    {
      schema: {
        tags,
        summary: 'Get CSRF token',
        description:
          'Public. Returns { csrfToken } and sets the CSRF cookie (__Host-meetops_csrf in production; Secure, Path=/, SameSite=Strict, Max-Age = session absolute timeout). The token is an HMAC bound to the current session id, or to an HttpOnly pre-session nonce cookie before login. Send it as X-CSRF-Token on every POST/PUT/PATCH/DELETE. Login returns a fresh token; org create/switch refresh the cookie; re-fetch after logout.',
        response: { 200: CsrfBody },
      },
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return { csrfToken: await g.issueCsrf(request, reply) };
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags,
        summary: 'Log out',
        description: 'Revokes the current session and clears the cookie.',
        response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody },
      },
    },
    async (request, reply) => {
      // ADR-021: logging out is always allowed, also while the MFA challenge is pending. With only a challenge cookie
      // (OQ-17: not a session) there is nothing to revoke: drop the challenge and answer 204.
      try {
        await g.requireSession(request, { allowMfaPending: true });
      } catch (e) {
        if (!(e instanceof MfaRequiredError)) throw e;
        g.clearSessionCookie(reply);
        return reply.status(204).send();
      }
      await auth.logout(g.readToken(request), requestMeta(request));
      g.clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  app.post(
    '/auth/logout-all',
    {
      schema: {
        tags,
        summary: 'Log out everywhere',
        description:
          'Revokes every session of the caller (including this one) and clears the cookie.',
        response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody },
      },
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      await auth.logoutAll(user.id, requestMeta(request));
      g.clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  app.get<{ Querystring: CursorPageQuery }>(
    '/auth/sessions',
    {
      schema: {
        tags,
        summary: 'List my sessions',
        description:
          'Active sessions (devices) of the caller; `current` marks this one. Cursor page.',
        querystring: CursorPageQuery,
        response: { 200: SessionList, 401: ErrorBody },
      },
    },
    async (request) => {
      const { user, session } = await g.requireSession(request);
      const items = (await auth.listSessions(user.id)).map((s) => ({
        id: s.id,
        current: s.id === session.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ip: capIp(s.ip),
        userAgent: capUserAgent(s.userAgent),
        ...sessionGeo(s.geo),
      }));
      return paginate(items, request.query);
    },
  );

  app.delete<{ Params: SessionIdParamsT }>(
    '/auth/sessions/:sessionId',
    {
      schema: {
        tags,
        summary: 'Revoke one of my sessions',
        description:
          "404 for unknown sessions and other users' sessions. Revoking the current one also clears the cookie.",
        params: SessionIdParams,
        response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody, 404: ErrorBody },
      },
    },
    async (request, reply) => {
      const { user, session } = await g.requireSession(request);
      await auth.revokeSession(user.id, request.params.sessionId, requestMeta(request));
      if (request.params.sessionId === session.id) g.clearSessionCookie(reply);
      return reply.status(204).send();
    },
  );

  app.post<{ Body: VerifyEmailBodyT }>(
    '/auth/verify-email',
    {
      schema: {
        tags,
        summary: 'Verify email address',
        description:
          "Consumes a single-use verification token (24 h TTL). Response header `x-meetops-verify-outcome`: `password_reset` after a mailbox-owner takeover that removed a password, `set_password` after one on an account without a password, else `verified`. From a live session of the account or the browser that signed up: marks the email verified and signs out the account's other sessions (in the account's own Google session, a pending Google sign-in is linked). From anywhere else, the mailbox owner takes the account over: the password and any Google link are removed, every session is revoked and a set-password (reset) link is emailed. Public; does not need a session.",
        body: VerifyEmailBody,
        response: {
          204: Type.Null(),
          400: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request, reply) => {
      const now = Date.now();
      const bound = openPendingLink(
        request.cookies[signupBinding.name],
        signupBinding.key,
        now,
        SIGNUP_BINDING_TTL_MS,
      );
      const pendingGoogle = openPendingLink(
        request.cookies[verifyLink.name],
        verifyLink.key,
        now,
        GOOGLE_VERIFY_LINK_TTL_MS,
      );
      const { proof, passwordRemoved } = await auth.verifyEmail(
        request.body.token,
        requestMeta(request),
        {
          currentToken: g.readToken(request),
          signupBinding: bound?.userId ?? null,
          googleVerifyLink: pendingGoogle,
        },
      );
      if (request.cookies[signupBinding.name] !== undefined)
        reply.clearCookie(signupBinding.name, signupBinding.attributes);
      if (request.cookies[verifyLink.name] !== undefined)
        reply.clearCookie(verifyLink.name, verifyLink.attributes);
      // UX-1: tell the token holder (only) whether the mailbox-owner takeover ran, so the page can say the password was
      // removed and a set-password link was emailed. Additive header; the status stays 204 in every case.
      reply.header(
        VERIFY_OUTCOME_HEADER,
        proof !== 'mailbox'
          ? VERIFY_OUTCOMES.verified
          : passwordRemoved
            ? VERIFY_OUTCOMES.passwordReset
            : VERIFY_OUTCOMES.setPassword,
      );
      return reply.status(204).send();
    },
  );

  app.post<{ Body: ForgotPasswordBodyT }>(
    '/auth/resend-verification',
    {
      schema: {
        tags,
        summary: 'Resend verification email',
        description: 'Enumeration-safe: always 202 with the same message.',
        body: ResendVerificationBody,
        response: { 202: AcceptedBody, 403: ErrorBody, 429: ErrorBody },
      },
    },
    async (request, reply) => {
      await auth.resendVerification(request.body.email, requestMeta(request));
      return reply.status(202).send({ message: SIGNUP_MSG });
    },
  );

  app.get(
    '/auth/session',
    {
      schema: {
        tags,
        summary: 'Current session',
        description:
          'Returns the authenticated user and active organization. Slides the idle timeout. ADR-021: `session` carries the assurance level; while the MFA challenge is pending the body is reduced (no organizations) and `mfaRequired` is true.',
        response: { 200: GetSessionResponse, 401: ErrorBody },
      },
    },
    async (request) =>
      toSessionResponse(
        await g.requireSession(request, { allowMfaPending: true }),
        opts.organizations,
      ),
  );

  googleAuthRoutes(app, {
    auth,
    security,
    guards: g,
    webBaseUrl: opts.webBaseUrl,
    google: opts.google,
  });
}
