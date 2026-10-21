import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createLogger } from '@meetops/logger';
import { defaultModuleDeps, registerModules, type ModuleDeps } from './modules/index.js';

export function createServer(options: { deps?: Partial<ModuleDeps> } = {}) {
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

  void app.register(registerModules, defaultModuleDeps(options.deps));

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/ready', async () => {
    return { status: 'ready' };
  });

  return app;
}
