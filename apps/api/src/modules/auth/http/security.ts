import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService, RequestMeta, SessionResult } from '../application/auth.service.js';
import type { PublicUser } from '../../users/domain/user.js';
import { isMfaSession, type Session, type SessionPolicy } from '../domain/session.js';
import {
  CsrfError,
  MfaRequiredError,
  OriginForbiddenError,
  UnauthenticatedError,
} from '../domain/errors.js';
import { deriveOAuthStateKey } from '../application/google-oidc.js';
import {
  MFA_CHALLENGE_TTL_MS,
  openMfaChallenge,
  sealMfaChallenge,
  type MfaChallenge,
} from '../application/mfa-challenge.js';

/** R13: lifetime of the `__Host-meetops_presession` cookie. */
export const PRE_SESSION_MAX_AGE_S = 3600;

export interface AuthContext {
  user: PublicUser;
  session: Session;
  /** ADR-021: the user has an active MFA factor. Optional so older fakes/contexts keep compiling (absent = off). */
  mfaEnabled?: boolean;
}

/** ADR-021 D2: MFA is on for the user but this session has not passed the challenge (any level but exactly `mfa`). */
export const mfaPending = (ctx: Pick<AuthContext, 'session' | 'mfaEnabled'>): boolean =>
  ctx.mfaEnabled === true && !isMfaSession(ctx.session);

export interface RequireSessionOptions {
  /**
   * ADR-021: let an MFA-pending session through. Only for logout, GET /auth/session (reduced body), GET /auth/mfa and
   * POST /auth/mfa/challenge. Every other route gets 403 MFA_REQUIRED.
   */
  allowMfaPending?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** ADR-014 resolved client IP (see shared/geoip/client-ip.ts); set by an onRequest hook in server.ts. */
    clientIp: string | null;
  }
}

export interface HttpSecurityConfig {
  /** `__Host-meetops_sid` in production; `meetops_sid` only when NODE_ENV=development. */
  cookieName: string;
  /** `__Host-meetops_csrf` in production; `meetops_csrf` only when NODE_ENV=development. */
  csrfCookieName: string;
  /** HttpOnly random nonce that binds CSRF tokens issued before a session exists. */
  preSessionCookieName: string;
  /** HttpOnly, SameSite=Lax PKCE/state cookie for the Google redirect (10 minutes). */
  oauthStateCookieName: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionPolicy: SessionPolicy;
  /** HMAC key for CSRF tokens (CSRF_SECRET). >= 32 bytes. */
  csrfSecret: Buffer;
}

export const CSRF_HEADER = 'x-csrf-token';
export const DEV_WEB_ORIGINS = ['http://localhost:5173', 'http://localhost:3000'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Only NODE_ENV=development drops __Host-/Secure; everything else (incl. unset) is strict. */
export function cookieConfig(nodeEnv: string | undefined) {
  const dev = nodeEnv === 'development';
  const p = dev ? '' : '__Host-';
  return {
    cookieName: `${p}meetops_sid`,
    csrfCookieName: `${p}meetops_csrf`,
    preSessionCookieName: `${p}meetops_presession`,
    oauthStateCookieName: `${p}meetops_oauth`,
    cookieSecure: !dev,
  };
}

/** Production must use __Host- cookies with Secure; throws otherwise. */
export function assertProductionCookies(cfg: HttpSecurityConfig) {
  const names = [
    cfg.cookieName,
    cfg.csrfCookieName,
    cfg.preSessionCookieName,
    cfg.oauthStateCookieName,
  ];
  if (!cfg.cookieSecure || names.some((n) => !n.startsWith('__Host-'))) {
    throw new Error('Production cookies must use the __Host- prefix and Secure');
  }
  if (cfg.csrfSecret.length < 32) throw new Error('CSRF_SECRET must be at least 32 bytes');
}

/** Contracts SessionSummary limits: an IP fits in 45 chars (IPv4-mapped IPv6); user agents are truncated. */
export const MAX_IP_LENGTH = 45;
export const MAX_USER_AGENT_LENGTH = 1024;
export const capIp = (ip: string | null | undefined) => (ip ? ip.slice(0, MAX_IP_LENGTH) : null);
export const capUserAgent = (ua: string | null | undefined) =>
  ua ? ua.slice(0, MAX_USER_AGENT_LENGTH) : null;

export const requestMeta = (r: FastifyRequest): RequestMeta => ({
  ip: capIp(r.clientIp ?? r.ip),
  userAgent: capUserAgent(r.headers['user-agent']),
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
  if (!origin || !allowed.includes(origin)) throw new OriginForbiddenError();
}

/**
 * CSRF token = `<nonce>.<HMAC-SHA256(secret, "<binding>.<nonce>")>` where binding is
 * `s:<sessionId>` for an authenticated session, or `p:<preSessionNonce>` before login.
 */
export function signCsrf(
  secret: Buffer,
  binding: string,
  nonce = randomBytes(18).toString('base64url'),
) {
  const mac = createHmac('sha256', secret).update(`${binding}.${nonce}`).digest('base64url');
  return `${nonce}.${mac}`;
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifyCsrf(secret: Buffer, binding: string, token: string) {
  const nonce = token.split('.')[0];
  return !!nonce && safeEqual(signCsrf(secret, binding, nonce), token);
}

/**
 * ADR-021 OQ-17: the MFA challenge cookie (`__Host-meetops_mfa` in production). HttpOnly, SameSite=Strict, its own
 * HKDF key, 5 minutes. Not a session cookie: only POST /auth/mfa/challenge and logout read it.
 */
export function mfaChallengeCookie(cfg: HttpSecurityConfig) {
  return {
    name: cfg.cookieName.replace(/meetops_sid$/, 'meetops_mfa'),
    key: deriveOAuthStateKey(cfg.csrfSecret, 'mfa-challenge'),
    maxAgeS: Math.floor(MFA_CHALLENGE_TTL_MS / 1000),
    attributes: {
      secure: cfg.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
      httpOnly: true,
    },
  };
}

export function makeGuards(auth: AuthService, cfg: HttpSecurityConfig) {
  const readToken = (r: FastifyRequest) => r.cookies[cfg.cookieName];
  const mfaCookie = mfaChallengeCookie(cfg);
  const readMfaChallenge = (r: FastifyRequest): MfaChallenge | null =>
    openMfaChallenge(r.cookies[mfaCookie.name], mfaCookie.key, Date.now());
  const setMfaChallengeCookie = (reply: FastifyReply, c: MfaChallenge) =>
    reply.setCookie(mfaCookie.name, sealMfaChallenge(c, mfaCookie.key), {
      ...mfaCookie.attributes,
      maxAge: mfaCookie.maxAgeS,
    });
  const clearMfaChallengeCookie = (reply: FastifyReply) =>
    reply.clearCookie(mfaCookie.name, mfaCookie.attributes);

  /** The CSRF binding for this request: the valid session if any, else the pre-session nonce. */
  const bindingFor = async (request: FastifyRequest): Promise<string | null> => {
    const token = readToken(request);
    if (token) {
      try {
        const ctx = await auth.authenticate(token, requestMeta(request));
        request.auth = ctx;
        return `s:${ctx.session.id}`;
      } catch {
        // fall through to the pre-session binding
      }
    }
    const pre = request.cookies[cfg.preSessionCookieName];
    return pre ? `p:${pre}` : null;
  };

  /** Origin check, then double-submit (header == cookie) and HMAC binding to session/pre-session. */
  const mutationGuard = async (request: FastifyRequest) => {
    if (SAFE_METHODS.has(request.method)) return;
    assertOrigin(request, cfg.allowedOrigins);
    const header = request.headers[CSRF_HEADER];
    const cookie = request.cookies[cfg.csrfCookieName];
    if (typeof header !== 'string' || !header || !cookie || !safeEqual(header, cookie))
      throw new CsrfError();
    const binding = await bindingFor(request);
    if (!binding || !verifyCsrf(cfg.csrfSecret, binding, header)) throw new CsrfError();
  };

  const requireSession = async (
    request: FastifyRequest,
    opts: RequireSessionOptions = {},
  ): Promise<AuthContext> => {
    let ctx: AuthContext;
    try {
      ctx = await auth.authenticate(readToken(request), requestMeta(request));
    } catch (e) {
      // OQ-17: no session, but a live MFA challenge: say what is missing instead of a bare 401. The challenge itself
      // never authenticates anything.
      if (e instanceof UnauthenticatedError && readMfaChallenge(request))
        throw new MfaRequiredError();
      throw e;
    }
    request.auth = ctx;
    if (!opts.allowMfaPending && mfaPending(ctx)) throw new MfaRequiredError();
    return ctx;
  };

  const baseCookie = { secure: cfg.cookieSecure, sameSite: 'lax' as const, path: '/' };

  const setSessionCookie = (reply: FastifyReply, r: SessionResult) =>
    reply.setCookie(cfg.cookieName, r.token, {
      ...baseCookie,
      httpOnly: true,
      maxAge: Math.floor(cfg.sessionPolicy.absoluteTimeoutMs / 1000),
    });

  // R13: the CSRF cookie is only read by same-site JS, so it is Strict and lives as long as a session can.
  const csrfCookie = {
    ...baseCookie,
    sameSite: 'strict' as const,
    httpOnly: false,
    maxAge: Math.floor(cfg.sessionPolicy.absoluteTimeoutMs / 1000),
  };
  const preSessionCookie = { ...baseCookie, sameSite: 'strict' as const, httpOnly: true };

  /** R14: logout clears the session, CSRF and pre-session cookies with matching name/path/attributes. */
  const clearSessionCookie = (reply: FastifyReply) => {
    reply.clearCookie(cfg.cookieName, { ...baseCookie, httpOnly: true });
    reply.clearCookie(cfg.csrfCookieName, { ...baseCookie, sameSite: 'strict', httpOnly: false });
    reply.clearCookie(cfg.preSessionCookieName, preSessionCookie);
    reply.clearCookie(mfaCookie.name, mfaCookie.attributes);
    return reply;
  };

  const setCsrfCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(cfg.csrfCookieName, token, csrfCookie);
    return token;
  };

  /** Issue a CSRF token bound to a known session (after login / rotation). */
  /** R17: a new session (login, org switch/create) gets a fresh token; the pre-session nonce is retired with it. */
  const issueCsrfForSession = (reply: FastifyReply, sessionId: string) => {
    reply.clearCookie(cfg.preSessionCookieName, preSessionCookie);
    return setCsrfCookie(reply, signCsrf(cfg.csrfSecret, `s:${sessionId}`));
  };

  /** GET /auth/csrf: bind to the current session, or to a (new) pre-session nonce cookie. */
  const issueCsrf = async (request: FastifyRequest, reply: FastifyReply) => {
    const binding = await bindingFor(request);
    if (binding) return setCsrfCookie(reply, signCsrf(cfg.csrfSecret, binding));
    const pre = randomBytes(32).toString('base64url');
    // R13: the pre-session nonce only has to survive the login form, so it expires after an hour and is Strict.
    reply.setCookie(cfg.preSessionCookieName, pre, {
      ...preSessionCookie,
      maxAge: PRE_SESSION_MAX_AGE_S,
    });
    return setCsrfCookie(reply, signCsrf(cfg.csrfSecret, `p:${pre}`));
  };

  return {
    readToken,
    readMfaChallenge,
    setMfaChallengeCookie,
    clearMfaChallengeCookie,
    requireSession,
    setSessionCookie,
    clearSessionCookie,
    issueCsrf,
    issueCsrfForSession,
    mutationGuard,
  };
}
