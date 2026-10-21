import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiErrorCode, ApiErrorEnvelope } from '@meetops/contracts';
import { DomainError } from './domain-error.js';
import { RateLimitedError } from '../modules/auth/domain/errors.js';

const GENERIC: Record<number, [ApiErrorCode, string]> = {
  400: ['BAD_REQUEST', 'Bad request'],
  401: ['UNAUTHENTICATED', 'Authentication required'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not found'],
  409: ['CONFLICT', 'Conflict'],
  429: ['RATE_LIMITED', 'Too many requests, try again later']
};

/** Generic code/message for any 4xx status (e.g. 413, 415 fall back to BAD_REQUEST). */
export function genericClientError(status: number): [ApiErrorCode, string] {
  return GENERIC[status] ?? ['BAD_REQUEST', 'Bad request'];
}

/**
 * Maps every error to the contracts ApiErrorEnvelope. Domain errors keep their safe message.
 * Other 4xx errors keep their status but get a generic message (never framework internals);
 * everything else is a generic 500. Never echoes request bodies.
 */
export function registerDomainErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | DomainError, request, reply) => {
    const send = (status: number, error: Omit<ApiErrorEnvelope['error'], 'requestId'>) =>
      reply.status(status).send({ error: { ...error, requestId: request.id } });
    if (err instanceof DomainError) {
      if (err instanceof RateLimitedError) void reply.header('retry-after', Math.ceil(err.retryAfterMs / 1000));
      return send(err.statusCode, { code: err.code, message: err.message });
    }
    if ('validation' in err && err.validation) {
      return send(400, {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: err.validation.map((v) => ({ path: v.instancePath || '/', message: 'invalid' }))
      });
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      const [code, message] = genericClientError(status);
      return send(status, { code, message });
    }
    request.log.error({ errName: err.name, errCode: err.code }, 'Unhandled error');
    return send(500, { code: 'INTERNAL', message: 'Internal server error' });
  });
}

export function registerNotFoundHandler(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: request.id } })
  );
}
