import Fastify, { type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createLogger } from '@meetops/logger';
import { defaultModuleDeps, registerModules, type ModuleDeps } from './modules/index.js';
import { registerDomainErrorHandler, registerNotFoundHandler } from './shared/http-errors.js';
import { parseTrustProxy } from './shared/trust-proxy.js';

export interface CreateServerOptions {
  deps?: Partial<ModuleDeps>;
  /** Overrides TRUST_PROXY. */
  trustProxy?: string;
  /** Overrides NODE_ENV for dependency validation. */
  nodeEnv?: string;
}

export function createServer(options: CreateServerOptions = {}) {
  const logger: FastifyBaseLogger = createLogger({ name: 'api' });
  // Throws in production when persistence/rate-limit implementations are not injected.
  const deps = defaultModuleDeps(options.deps, { nodeEnv: options.nodeEnv ?? process.env.NODE_ENV });
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: parseTrustProxy(options.trustProxy ?? process.env.TRUST_PROXY)
  });

  registerDomainErrorHandler(app);
  registerNotFoundHandler(app);

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

  void app.register(registerModules, deps);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/ready', async () => {
    return { status: 'ready' };
  });

  return app;
}
