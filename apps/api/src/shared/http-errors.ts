import type { FastifyError, FastifyInstance } from 'fastify';
import { DomainError } from './domain-error.js';
import { RateLimitedError } from '../modules/auth/domain/errors.js';
import type { ApiErrorEnvelope } from './contracts/index.js';

/** Maps errors to the contracts ApiErrorEnvelope. Never echoes request bodies. */
export function registerDomainErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | DomainError, request, reply) => {
    const send = (status: number, error: ApiErrorEnvelope['error']) =>
      reply.status(status).send({ error: { ...error, requestId: request.id } });
    if (err instanceof DomainError) {
      if (err instanceof RateLimitedError) void reply.header('retry-after', Math.ceil(err.retryAfterMs / 1000));
      return send(err.statusCode, { code: err.code, message: err.message });
    }
    if ('validation' in err && err.validation) {
      return send(400, {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: err.validation.map((v) => ({ path: v.instancePath || '/', message: v.message ?? 'invalid' }))
      });
    }
    request.log.error({ errName: err.name, errMessage: err.message }, 'Unhandled error');
    return send(500, { code: 'INTERNAL', message: 'Internal server error' });
  });
}
