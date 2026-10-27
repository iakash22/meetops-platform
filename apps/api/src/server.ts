import Fastify, { type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { REDACT_KEYS } from '@meetops/contracts';
import { createLogger } from '@meetops/logger';
import {
  isRelaxedEnv,
  defaultModuleDeps,
  registerModules,
  type ModuleDeps,
} from './modules/index.js';
import { registerDomainErrorHandler, registerNotFoundHandler } from './shared/http-errors.js';
import { parseTrustProxy } from './shared/trust-proxy.js';

/** Node lowercases incoming header names, so these cover any case of X-CSRF-Token/Cookie/Authorization. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-csrf-token"]',
  '*.password',
  '*.secret',
  '*.token',
  '*.csrfToken',
  '*.apiKey',
  '*.api_key',
  '*.access_token',
  '*.refresh_token',
  '*.accessToken',
  '*.refreshToken',
  '*.pairingCode',
  '*.nonce',
];

/**
 * Ajv request-validation options, pinned explicitly (they match Fastify's defaults). Coercion must stay on:
 * query strings arrive as text, e.g. GET /orgs/:id/tasks?unassigned=true must validate against Literal(true).
 * removeAdditional is OFF (Fastify defaults it to true): with it on, Ajv strips `unassigned` while trying the
 * first anyOf branch of a strict union and the query silently loses the filter. Strict (additionalProperties:
 * false) contract schemas therefore reject unknown keys with 400 instead of dropping them.
 */
export const AJV_CUSTOM_OPTIONS = {
  coerceTypes: 'array',
  useDefaults: true,
  removeAdditional: false,
} as const;

export interface CreateServerOptions {
  deps?: Partial<ModuleDeps>;
  /** Overrides TRUST_PROXY. */
  trustProxy?: string;
  /** Overrides NODE_ENV for dependency validation (only 'development'/'test' are relaxed). */
  nodeEnv?: string;
  /** Overrides DATABASE_URL for the default Prisma repositories ('' disables them). */
  databaseUrl?: string;
  /** Overrides REDIS_URL for the default Redis rate limiter and lockout ('' disables them). */
  redisUrl?: string;
}

export function createServer(options: CreateServerOptions = {}) {
  const logger: FastifyBaseLogger = createLogger({
    name: 'api',
    // Superset of @meetops/logger defaults plus CSRF/auth headers (any case, via lowercased Node headers).
    redact: { paths: REDACT_PATHS, censor: '***redacted***' },
    // ADR-005 A1.5: contracts REDACT_KEYS at any depth (fast-redact `*.` paths above are one level only).
    redactKeys: REDACT_KEYS,
  });
  // Throws in production when persistence/rate-limit implementations are neither injected nor
  // backed by DATABASE_URL / REDIS_URL.
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const deps = defaultModuleDeps(options.deps, {
    nodeEnv,
    databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL,
    redisUrl: options.redisUrl ?? process.env.REDIS_URL,
  });
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: parseTrustProxy(options.trustProxy ?? process.env.TRUST_PROXY),
    ajv: { customOptions: { ...AJV_CUSTOM_OPTIONS } },
  });

  registerDomainErrorHandler(app);
  registerNotFoundHandler(app);

  void app.register(swagger, {
    openapi: {
      info: {
        title: 'MeetOps AI API',
        version: '0.0.0',
      },
    },
  });

  // Swagger UI and its /docs/json spec only for NODE_ENV exactly development|test (fail closed).
  // The spec is still generated in-process (app.swagger()) for tests and tooling.
  if (isRelaxedEnv(nodeEnv)) {
    void app.register(swaggerUi, {
      routePrefix: '/docs',
    });
  }

  void app.register(registerModules, deps);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/ready', async () => {
    return { status: 'ready' };
  });

  return app;
}
