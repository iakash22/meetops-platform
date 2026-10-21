import type { FastifyError, FastifyInstance } from 'fastify';
import { DomainError } from './domain-error.js';

/** Maps DomainError to { error: { code, message } }. Never echoes request bodies. */
export function registerDomainErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | DomainError, request, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if ("validation" in err && err.validation) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    request.log.error({ errName: err.name, errMessage: err.message }, 'Unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
}
