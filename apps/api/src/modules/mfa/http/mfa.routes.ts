import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  MFA_PATHS,
  MfaCodeRequest,
  MfaElevationResponse,
  MfaFactorParams,
  MfaRecoveryCodesResponse,
  MfaStatusResponse,
  MfaTotpConfirmRequest,
  MfaTotpConfirmResponse,
  MfaTotpEnrollResponse,
} from '@meetops/contracts';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import { DomainError } from '../../../shared/domain-error.js';
import type { AuthService } from '../../auth/application/auth.service.js';
import { UnauthenticatedError } from '../../auth/domain/errors.js';
import { stepUpExpiresAt, type Session } from '../../auth/domain/session.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from '../../auth/http/security.js';
import type { MfaService } from '../application/mfa.service.js';

export interface MfaRoutesOptions {
  auth: AuthService;
  mfa: MfaService;
  security: HttpSecurityConfig;
}

const tags = ['auth', 'mfa'];
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 429: ErrorBody, 503: ErrorBody };
const CODE_FIELDS = ['totpCode', 'recoveryCode', 'factorId'] as const;

/**
 * TOTP-06: the server's Ajv coerces types (`coerceTypes: 'array'`), which would turn `123456` or `['123456']` into a
 * string. Codes must arrive as JSON strings, so anything else is refused BEFORE validation and never reaches the
 * verifier (and never costs a lockout attempt).
 */
async function codesMustBeStrings(request: FastifyRequest) {
  const body = request.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  for (const k of CODE_FIELDS)
    if (k in body && typeof body[k] !== 'string')
      throw new DomainError('VALIDATION_FAILED', 'Request validation failed', 400);
}

const noStore = (reply: FastifyReply) => void reply.header('cache-control', 'no-store');
const stepUpUntil = (s: Session) => {
  const until = stepUpExpiresAt(s);
  return until ? until.toISOString() : null;
};

export async function mfaRoutes(app: FastifyInstance, opts: MfaRoutesOptions) {
  registerDomainErrorHandler(app);
  const { mfa, security } = opts;
  const g = makeGuards(opts.auth, security);
  app.addHook('onRequest', g.mutationGuard);

  app.get(
    MFA_PATHS.status,
    {
      schema: {
        tags,
        summary: 'My MFA factors',
        description:
          'Factors of the caller (never secrets or recovery codes) and how many recovery codes are left.',
        response: { 200: MfaStatusResponse, ...errors },
      },
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      noStore(reply);
      return mfa.status(user.id);
    },
  );

  app.post(
    MFA_PATHS.enroll,
    {
      schema: {
        tags,
        summary: 'Start TOTP enrolment',
        description:
          'Returns the secret and otpauth URI ONCE (Cache-Control: no-store). The factor stays pending for 10 minutes until confirmed. Needs a verified email; with an active factor it is a replacement and needs a fresh step-up (403 STEP_UP_REQUIRED).',
        response: { 201: MfaTotpEnrollResponse, ...errors },
      },
    },
    async (request, reply) => {
      const caller = await g.requireSession(request);
      const r = await mfa.enroll(caller, requestMeta(request));
      noStore(reply);
      return reply.status(201).send(r);
    },
  );

  app.post<{ Body: MfaTotpConfirmRequest }>(
    MFA_PATHS.confirm,
    {
      preValidation: codesMustBeStrings,
      schema: {
        tags,
        summary: 'Confirm TOTP enrolment',
        description:
          'Activates the pending factor, turns MFA on, returns the recovery codes ONCE (no-store), rotates this session to level mfa (new cookie and CSRF token) and signs out every other session. Wrong code: 400 INVALID_MFA_CODE (shares the login lockout).',
        body: MfaTotpConfirmRequest,
        response: { 200: MfaTotpConfirmResponse, 404: ErrorBody, ...errors },
      },
    },
    async (request, reply) => {
      const caller = await g.requireSession(request);
      const r = await mfa.confirm(
        caller,
        request.body.factorId,
        request.body.totpCode,
        requestMeta(request),
      );
      g.setSessionCookie(reply, r.session);
      noStore(reply);
      return {
        factor: r.factor,
        recoveryCodes: r.recoveryCodes,
        csrfToken: g.issueCsrfForSession(reply, r.session.session.id),
      };
    },
  );

  app.post<{ Body: MfaCodeRequest }>(
    MFA_PATHS.challenge,
    {
      preValidation: codesMustBeStrings,
      schema: {
        tags,
        summary: 'Finish sign-in with MFA',
        description:
          'ADR-021 OQ-17: after POST /auth/login (or Google) answered mfaRequired, send a TOTP code or a recovery code. Reads the short-lived HttpOnly challenge cookie (not a session). Success issues the session at level mfa with a fresh step-up, a new CSRF token, and clears the challenge. 400 INVALID_MFA_CODE (generic), 401 without a live challenge, 429 when rate-limited or locked (shared with login).',
        body: MfaCodeRequest,
        response: { 200: MfaElevationResponse, ...errors },
      },
    },
    async (request, reply) => {
      const challenge = g.readMfaChallenge(request);
      if (!challenge) throw new UnauthenticatedError();
      const r = await mfa.completeLogin(
        challenge,
        request.body,
        requestMeta(request),
        g.readToken(request),
      );
      g.clearMfaChallengeCookie(reply);
      g.setSessionCookie(reply, r.session);
      noStore(reply);
      return {
        csrfToken: g.issueCsrfForSession(reply, r.session.session.id),
        authLevel: r.session.session.authLevel ?? 'password',
        stepUpExpiresAt: stepUpUntil(r.session.session),
        ...(r.recoveryCodesRemaining !== undefined
          ? { recoveryCodesRemaining: r.recoveryCodesRemaining }
          : {}),
      };
    },
  );
  app.post<{ Body: MfaCodeRequest }>(
    MFA_PATHS.stepUp,
    {
      preValidation: codesMustBeStrings,
      schema: {
        tags,
        summary: 'Step up (confirm it is you)',
        description:
          'ADR-021 Decision 4: send a TOTP or recovery code. Rotates the session (new cookie and CSRF token, same absolute expiry) and makes sensitive actions available for 10 minutes. 403 FORBIDDEN without MFA, 400 INVALID_MFA_CODE (shares the login lockout), 429 when rate-limited or locked.',
        body: MfaCodeRequest,
        response: { 200: MfaElevationResponse, ...errors },
      },
    },
    async (request, reply) => {
      const caller = await g.requireSession(request);
      const r = await mfa.stepUp(caller, request.body, requestMeta(request));
      g.setSessionCookie(reply, r.session);
      noStore(reply);
      return {
        csrfToken: g.issueCsrfForSession(reply, r.session.session.id),
        authLevel: r.session.session.authLevel ?? 'password',
        stepUpExpiresAt: stepUpUntil(r.session.session),
        ...(r.recoveryCodesRemaining !== undefined
          ? { recoveryCodesRemaining: r.recoveryCodesRemaining }
          : {}),
      };
    },
  );

  app.post(
    MFA_PATHS.recoveryCodes,
    {
      schema: {
        tags,
        summary: 'Regenerate recovery codes',
        description:
          'Needs a fresh step-up (403 STEP_UP_REQUIRED). Returns 10 new codes ONCE (no-store); every old code stops working.',
        response: { 200: MfaRecoveryCodesResponse, 404: ErrorBody, ...errors },
      },
    },
    async (request, reply) => {
      const caller = await g.requireSession(request);
      const r = await mfa.regenerateRecoveryCodes(caller, requestMeta(request));
      noStore(reply);
      return r;
    },
  );

  app.delete<{ Params: MfaFactorParams }>(
    MFA_PATHS.factor,
    {
      schema: {
        tags,
        summary: 'Remove an MFA factor',
        description:
          'Removing the active factor turns MFA off. Needs a fresh step-up while MFA is on (403 STEP_UP_REQUIRED); signs out every other session and device. 404 for unknown or foreign ids.',
        params: MfaFactorParams,
        response: { 204: Type.Null(), 404: ErrorBody, ...errors },
      },
    },
    async (request, reply) => {
      const caller = await g.requireSession(request);
      await mfa.disable(caller, request.params.factorId, requestMeta(request));
      return reply.status(204).send();
    },
  );
}
