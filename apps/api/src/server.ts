import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createLogger } from '@meetops/logger';

export function createServer(): FastifyInstance {
  const logger = createLogger({ name: 'api' });
  const app = Fastify({
    logger
  });

  void app.register(swagger, {
    openapi: {
      info: {
        title: 'MeetOps AI API',
        version: '0.0.0'
      }
    }
  });

  void app.register(swaggerUi, {
    routePrefix: '/docs'
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/ready', async () => {
    return { status: 'ready' };
  });

  return app;
}
