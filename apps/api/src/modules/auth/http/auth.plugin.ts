import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from '../application/auth.service.js';
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
  type ForgotPasswordBodyT,
  type LoginBodyT,
  type ResetPasswordBodyT,
  type SignupBodyT
} from './schemas.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from './security.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { toSessionResponse } from './mappers.js';

export interface AuthPluginOptions {
  auth: AuthService;
  security: HttpSecurityConfig;
  organizations: OrganizationService;
}

const tags = ['auth'];
const SIGNUP_MSG = 'Check your email to continue.';
const RESET_MSG = 'If an account exists for that email, we sent a reset link.';

export async function authRoutes(app: FastifyInstance, opts: AuthPluginOptions) {
  registerDomainErrorHandler(app);
  const { auth, security } = opts;
  const g = makeGuards(auth, security);
  app.addHook('onRequest', g.mutationGuard);

  app.post<{ Body: SignupBodyT }>(
    '/auth/signup',
    {
      schema: {
        tags,
        summary: 'Create an account',
        description:
          'Enumeration-safe: always 202 with the same message whether or not the email exists. Does not start a session; log in afterwards.',
        body: SignupBody,
        response: { 202: AcceptedBody, 400: ErrorBody, 403: ErrorBody, 429: ErrorBody }
      }
    },
    async (request, reply) => {
      await auth.signup(request.body, requestMeta(request));
      return reply.status(202).send({ message: SIGNUP_MSG });
    }
  );

  app.post<{ Body: LoginBodyT }>(
    '/auth/login',
    {
      schema: {
        tags,
        summary: 'Log in',
        description:
          'Verifies credentials, revokes any presented session, sets a new httpOnly session cookie and a fresh CSRF cookie (also returned as csrfToken). Generic 401 AUTH_FAILED on failure; 429 when rate-limited or locked.',
        body: LoginBody,
        response: { 200: SessionResponse, 401: ErrorBody, 403: ErrorBody, 429: ErrorBody }
      }
    },
    async (request, reply) => {
      const r = await auth.login(request.body, requestMeta(request), g.readToken(request));
      g.setSessionCookie(reply, r);
      return { ...(await toSessionResponse(r, opts.organizations)), csrfToken: g.issueCsrfForSession(reply, r.session.id) };
    }
  );

  app.post<{ Body: ForgotPasswordBodyT }>(
    '/auth/forgot-password',
    {
      schema: {
        tags,
        summary: 'Request a password reset',
        description: 'Enumeration-safe: always 202 with the same message.',
        body: ForgotPasswordBody,
        response: { 202: AcceptedBody, 403: ErrorBody, 429: ErrorBody }
      }
    },
    async (request, reply) => {
      await auth.requestPasswordReset(request.body.email, requestMeta(request));
      return reply.status(202).send({ message: RESET_MSG });
    }
  );

  app.post<{ Body: ResetPasswordBodyT }>(
    '/auth/reset-password',
    {
      schema: {
        tags,
        summary: 'Reset password',
        description: 'Consumes a single-use reset token (30 min TTL) and revokes all sessions for the user.',
        body: ResetPasswordBody,
        response: { 204: Type.Null(), 400: ErrorBody, 403: ErrorBody, 429: ErrorBody }
      }
    },
    async (request, reply) => {
      await auth.resetPassword(request.body, requestMeta(request));
      g.clearSessionCookie(reply);
      return reply.status(204).send();
    }
  );

  app.get(
    '/auth/csrf',
    {
      schema: {
        tags,
        summary: 'Get CSRF token',
        description:
          'Public. Returns { csrfToken } and sets the CSRF cookie (__Host-meetops_csrf in production; Secure, Path=/, SameSite=Lax). The token is an HMAC bound to the current session id, or to an HttpOnly pre-session nonce cookie before login. Send it as X-CSRF-Token on every POST/PUT/PATCH/DELETE. Login returns a fresh token; org create/switch refresh the cookie; re-fetch after logout.',
        response: { 200: CsrfBody }
      }
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      return { csrfToken: await g.issueCsrf(request, reply) };
    }
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags,
        summary: 'Log out',
        description: 'Revokes the current session and clears the cookie.',
        response: { 204: Type.Null(), 401: ErrorBody, 403: ErrorBody }
      }
    },
    async (request, reply) => {
      await g.requireSession(request);
      await auth.logout(g.readToken(request));
      g.clearSessionCookie(reply);
      return reply.status(204).send();
    }
  );

  app.get(
    '/auth/session',
    {
      schema: {
        tags,
        summary: 'Current session',
        description: 'Returns the authenticated user and active organization. Slides the idle timeout.',
        response: { 200: GetSessionResponse, 401: ErrorBody }
      }
    },
    async (request) => toSessionResponse(await g.requireSession(request), opts.organizations)
  );
}
