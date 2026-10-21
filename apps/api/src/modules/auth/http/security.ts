import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService, RequestMeta, SessionResult } from '../application/auth.service.js';
import type { PublicUser } from '../../users/domain/user.js';
import type { Session, SessionPolicy } from '../domain/session.js';
import { CsrfError } from '../domain/errors.js';

export interface AuthContext {
  user: PublicUser;
  session: Session;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface HttpSecurityConfig {
  /** __Host-meetops_sid in production; meetops_sid only when NODE_ENV=development. */
  cookieName: string;
  /** __Host-meetops_csrf in production; meetops_csrf only when NODE_ENV=development. */
  csrfCookieName: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionPolicy: SessionPolicy;
}

export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cookieConfig(nodeEnv: string | undefined) {
  const dev = nodeEnv === 'development';
  return {
    cookieName: dev ? 'meetops_sid' : '__Host-meetops_sid',
    csrfCookieName: dev ? 'meetops_csrf' : '__Host-meetops_csrf',
    cookieSecure: !dev
  };
}

export const requestMeta = (r: FastifyRequest): RequestMeta => ({
  ip: r.ip ?? null,
  userAgent: r.headers['user-agent'] ?? null
});

/** Reject state-changing requests whose Origin (fallback Referer) is not allowlisted. Missing both → reject. */
export function assertOrigin(request: FastifyRequest, allowed: string[]) {
  if (SAFE_METHODS.has(request.method)) return;
  let origin = request.headers.origin;
  if (!origin && request.headers.referer) {
    try {
      origin = new URL(request.headers.referer).origin;
    } catch {
      origin = undefined;
    }
  }
  if (!origin || !allowed.includes(origin)) throw new CsrfError('Origin not allowed');
}

/** Double-submit: X-CSRF-Token header must equal the CSRF cookie on every mutation. */
export function assertCsrf(request: FastifyRequest, cookieName: string) {
  if (SAFE_METHODS.has(request.method)) return;
  const header = request.headers[CSRF_HEADER];
  const cookie = request.cookies[cookieName];
  if (typeof header !== 'string' || !header || !cookie) throw new CsrfError();
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CsrfError();
}

/** onRequest hook used by every module plugin: Origin check, then CSRF double-submit. */
export function mutationGuard(cfg: HttpSecurityConfig) {
  return async (request: FastifyRequest) => {
    assertOrigin(request, cfg.allowedOrigins);
    assertCsrf(request, cfg.csrfCookieName);
  };
}

export function makeGuards(auth: AuthService, cfg: HttpSecurityConfig) {
  const readToken = (r: FastifyRequest) => r.cookies[cfg.cookieName];

  const requireSession = async (request: FastifyRequest): Promise<AuthContext> => {
    const ctx = await auth.authenticate(readToken(request));
    request.auth = ctx;
    return ctx;
  };

  const setSessionCookie = (reply: FastifyReply, r: SessionResult) =>
    reply.setCookie(cfg.cookieName, r.token, {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.floor(cfg.sessionPolicy.absoluteTimeoutMs / 1000)
    });

  const clearSessionCookie = (reply: FastifyReply) =>
    reply.clearCookie(cfg.cookieName, { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' });

  /** Issues a fresh CSRF token and sets it as a readable (non-HttpOnly) cookie. */
  const issueCsrf = (reply: FastifyReply) => {
    const token = randomBytes(32).toString('base64url');
    reply.setCookie(cfg.csrfCookieName, token, { httpOnly: false, secure: cfg.cookieSecure, sameSite: 'lax', path: '/' });
    return token;
  };

  return { readToken, requireSession, setSessionCookie, clearSessionCookie, issueCsrf };
}
