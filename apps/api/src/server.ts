import Fastify, { type FastifyBaseLogger } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { REDACT_KEYS } from '@meetops/contracts';
import { createLogger } from '@meetops/logger';
import { defaultModuleDeps, registerModules, type ModuleDeps } from './modules/index.js';
import { registerDomainErrorHandler, registerNotFoundHandler } from './shared/http-errors.js';
import { parseTrustProxy } from './shared/trust-proxy.js';
import { docsEnabledFromEnv, registerSecurityHeaders } from './shared/security-headers.js';
import { docsAdminEmailsFromEnv, registerDocsAccessGuard } from './shared/docs-access.js';
import { registerJsonOnly } from './shared/json-only.js';
import { clientIpOptionsFromEnv, resolveClientIp } from './shared/geoip/client-ip.js';
import { truncateIp } from './shared/geoip/ip.js';
import { metricsTokenFromEnv, registerMetrics, type HttpMetrics } from './shared/metrics.js';
import {
  createReadiness,
  defaultReadinessChecks,
  readinessTimeoutFromEnv,
  type ReadinessCheck,
} from './shared/readiness.js';

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
  /** Overrides METRICS_TOKEN ('' disables /metrics). */
  metricsToken?: string;
  /** Inject a metrics registry (tests). */
  metrics?: HttpMetrics;
  /** Overrides the default /ready probes (Prisma `SELECT 1`, Redis `PING`). */
  readinessChecks?: ReadinessCheck[];
  /** Log destination (tests capture log lines). Defaults to stdout. */
  logStream?: { write(line: string): void };
  /** Overrides READINESS_TIMEOUT_MS (per-probe timeout for /ready). */
  readinessTimeoutMs?: number;
  /** Overrides API_DOCS_ENABLED (Swagger UI outside development|test; 'true' enables). */
  docsEnabled?: string;
  /** Overrides API_DOCS_ADMIN_EMAILS (who may open /docs outside development|test). */
  docsAdminEmails?: string;
  /** Overrides AUTH_MAIL_QUEUE* / AUTH_MAIL_WORKER_* (auth mail queue selection). */
  mailQueueEnv?: Record<string, string | undefined>;
}

export function createServer(options: CreateServerOptions = {}) {
  const logger: FastifyBaseLogger = createLogger(
    {
      name: 'api',
      // Superset of @meetops/logger defaults plus CSRF/auth headers (any case, via lowercased Node headers).
      redact: { paths: REDACT_PATHS, censor: '***redacted***' },
      // ADR-005 A1.5: contracts REDACT_KEYS at any depth (fast-redact `*.` paths above are one level only).
      redactKeys: REDACT_KEYS,
      // ADR-014 / #290 M-1: the single @meetops/logger req serializer truncates the client IP to /24 or /48
      // (never logged in full) and redacts sensitive query values (code/state/token).
      requestIp: truncateIp,
    },
    options.logStream,
  );
  // Throws in production when persistence/rate-limit implementations are neither injected nor
  // backed by DATABASE_URL / REDIS_URL.
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const deps = defaultModuleDeps(options.deps, {
    nodeEnv,
    databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL,
    redisUrl: options.redisUrl ?? process.env.REDIS_URL,
    emailEnv: process.env,
    mailQueueEnv: options.mailQueueEnv ?? process.env,
  });
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: parseTrustProxy(options.trustProxy ?? process.env.TRUST_PROXY, {
      production: nodeEnv === 'production',
    }),
    ajv: { customOptions: { ...AJV_CUSTOM_OPTIONS } },
  });

  // Request metrics are recorded always; /metrics is only served when METRICS_TOKEN is configured.
  registerMetrics(app, {
    token: metricsTokenFromEnv(options.metricsToken ?? process.env.METRICS_TOKEN),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });

  // ADR-014 client IP: request.ip after the TRUST_PROXY allowlist, or CF-Connecting-IP when BEHIND_CLOUDFLARE=true and
  // the peer is a pinned Cloudflare edge address. Raw X-Forwarded-For is never read.
  const clientIpOptions = clientIpOptionsFromEnv(process.env);
  app.decorateRequest('clientIp', null);
  app.addHook('onRequest', async (request) => {
    request.clientIp = resolveClientIp(
      request.ip,
      request.headers['cf-connecting-ip'],
      clientIpOptions,
    );
  });

  // P9: baseline security headers on every response (errors and 404s included); HSTS only in production.
  const docs = docsEnabledFromEnv(nodeEnv, options.docsEnabled ?? process.env.API_DOCS_ENABLED);
  registerSecurityHeaders(app, { hsts: nodeEnv === 'production', docs });

  // P9 R16: unsafe requests with a body must be JSON (415 otherwise) unless the route allowlists the type.
  registerJsonOnly(app);

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

  // Swagger UI and its /docs/json spec: NODE_ENV exactly development|test, or API_DOCS_ENABLED=true (fail closed).
  // Served under DOCS_CSP. The spec is still generated in-process (app.swagger()) for tests and tooling.
  // Outside development|test it also needs an authenticated session of an API_DOCS_ADMIN_EMAILS user (401/403).
  if (docs && nodeEnv !== 'development' && nodeEnv !== 'test') {
    registerDocsAccessGuard(app, {
      deps,
      cookieName: deps.security.cookieName,
      adminEmails: docsAdminEmailsFromEnv(
        options.docsAdminEmails ?? process.env.API_DOCS_ADMIN_EMAILS,
      ),
    });
  }
  if (docs) {
    void app.register(swaggerUi, {
      routePrefix: '/docs',
    });
  }

  void app.register(registerModules, deps);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Liveness (/health) never touches dependencies; readiness (/ready) probes the ones this process uses.
  const readiness = createReadiness(
    options.readinessChecks ?? defaultReadinessChecks(deps),
    options.readinessTimeoutMs ?? readinessTimeoutFromEnv(process.env.READINESS_TIMEOUT_MS),
  );
  app.get('/ready', { logLevel: 'warn' }, async (_req, reply) => {
    const report = await readiness.check();
    if (readiness.names.length === 0) return { status: 'ready' };
    if (!report.ready) {
      // Names and outcomes only: no error text, hosts or connection strings.
      app.log.warn({ readiness: report.checks }, 'readiness check failed');
      return reply.code(503).send({ status: 'not_ready', checks: report.checks });
    }
    return { status: 'ready', checks: report.checks };
  });

  return app;
}
