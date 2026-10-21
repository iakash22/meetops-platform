import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService, SessionResult } from '../application/auth.service.js';
import type { PublicUser as PublicUserEntity } from '../../users/domain/user.js';
import type { Session } from '../domain/session.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import { ErrorBody, LoginBody, SessionResponse, SignupBody, type LoginBodyT, type SignupBodyT } from './schemas.js';

export const SESSION_COOKIE = 'meetops_session';

export interface AuthContext {
  user: PublicUserEntity;
  session: Session;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AuthPluginOptions {
  auth: AuthService;
  cookieSecure: boolean;
  sessionTtlMs: number;
}

export function toSessionResponse(ctx: { user: PublicUserEntity; session: Session }) {
  return {
    user: { ...ctx.user, createdAt: ctx.user.createdAt.toISOString() },
    session: {
      activeOrganizationId: ctx.session.activeOrganizationId,
      expiresAt: ctx.session.expiresAt.toISOString()
    }
  };
}

/** preHandler factory: resolves the session cookie into request.auth or 401s. */
export function requireAuth(auth: AuthService) {
  return async (request: FastifyRequest): Promise<void> => {
    request.auth = await auth.authenticate(request.cookies[SESSION_COOKIE]);
  };
}

const tags = ['auth'];

export async function authRoutes(app: FastifyInstance, opts: AuthPluginOptions) {
  registerDomainErrorHandler(app);
  const cookieOpts = {
    httpOnly: true,
    secure: opts.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(opts.sessionTtlMs / 1000)
  };
  const setCookie = (reply: FastifyReply, r: SessionResult) => reply.setCookie(SESSION_COOKIE, r.token, cookieOpts);

  app.post<{ Body: SignupBodyT }>(
    '/auth/signup',
    {
      schema: {
        tags,
        summary: 'Create an account',
        description: 'Creates a user (argon2id password hash) and starts a cookie session.',
        body: SignupBody,
        response: { 201: SessionResponse, 400: ErrorBody, 409: ErrorBody }
      }
    },
    async (request, reply) => {
      const r = await opts.auth.signup(request.body);
      setCookie(reply, r);
      return reply.status(201).send(toSessionResponse(r));
    }
  );

  app.post<{ Body: LoginBodyT }>(
    '/auth/login',
    {
      schema: {
        tags,
        summary: 'Log in',
        description: 'Verifies credentials and sets an httpOnly session cookie.',
        body: LoginBody,
        response: { 200: SessionResponse, 401: ErrorBody }
      }
    },
    async (request, reply) => {
      const r = await opts.auth.login(request.body);
      setCookie(reply, r);
      return toSessionResponse(r);
    }
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags,
        summary: 'Log out',
        description: 'Revokes the current session and clears the cookie. Idempotent.',
        response: { 204: Type.Null() }
      }
    },
    async (request, reply) => {
      await opts.auth.logout(request.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(204).send();
    }
  );

  app.get(
    '/auth/session',
    {
      schema: {
        tags,
        summary: 'Current session',
        description: 'Returns the authenticated user and active organization.',
        response: { 200: SessionResponse, 401: ErrorBody }
      }
    },
    async (request) => toSessionResponse(await opts.auth.authenticate(request.cookies[SESSION_COOKIE]))
  );
}
