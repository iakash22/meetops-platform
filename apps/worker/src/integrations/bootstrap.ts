import {
  GitHubAppClient,
  InMemoryOAuthStateStore,
  JiraOAuthClient,
  LocalKeyProvider,
  parseSharedKek,
  SharedKekError,
  TokenCipher,
} from '@meetops/integrations';
import { createIntegrationConnectionRepository } from '@meetops/database';
import { createQueue, createRedisClient, createWorker } from '@meetops/queue';
import { IntegrationsApiOriginError, integrationsApiOrigin } from './api-origin.js';
import {
  CONFIRM_LEASE_LUA,
  createRedisConnectionLease,
  LEASE_REDIS_OPTIONS,
  RELEASE_LEASE_LUA,
  type LeaseRedis,
} from '@meetops/integrations';
import {
  runTokenRefreshSweep,
  type TokenRefreshDeps,
  type TokenRefreshLog,
  type TokenRefreshProviders,
} from './token-refresh.js';

// Lease primitives live in @meetops/integrations (shared with the API); re-exported for existing imports.
export {
  CONFIRM_LEASE_LUA,
  createRedisConnectionLease,
  LEASE_REDIS_OPTIONS,
  RELEASE_LEASE_LUA,
  type LeaseRedis,
};

export class TokenRefreshEnvError extends Error {}

export interface TokenRefreshEnv {
  enabled: boolean;
  intervalMs: number;
  /** 32-byte KEK shared with the API (INTEGRATIONS_TOKEN_KEK, base64). Required when enabled. */
  kek?: Buffer;
}

const TRUE = new Set(['true', '1', 'yes', 'on']);

/**
 * INTEGRATIONS_TOKEN_REFRESH_ENABLED (default off). When on, INTEGRATIONS_TOKEN_KEK must decode to 32 bytes or
 * startup fails closed: the worker cannot decrypt tokens the API sealed with a different key. Errors name keys only.
 */
export function loadTokenRefreshEnv(env: NodeJS.ProcessEnv = process.env): TokenRefreshEnv {
  const enabled = TRUE.has(env.INTEGRATIONS_TOKEN_REFRESH_ENABLED?.trim().toLowerCase() ?? '');
  const rawInterval = env.INTEGRATIONS_TOKEN_REFRESH_INTERVAL_MS?.trim();
  const intervalMs = rawInterval ? Number(rawInterval) : 300_000;
  if (!Number.isInteger(intervalMs) || intervalMs < 30_000 || intervalMs > 3_600_000)
    throw new TokenRefreshEnvError(
      'INTEGRATIONS_TOKEN_REFRESH_INTERVAL_MS must be in 30000..3600000',
    );
  // Validated even when refresh is off: a set-but-bad or production KEK is always a startup error.
  const kek = parseKek(env);
  if (!enabled) return { enabled, intervalMs };
  // Jira refresh builds its redirect URI from the API origin: required (https, no default) in production.
  if (env.JIRA_CLIENT_ID?.trim()) apiOriginOrThrow(env);
  if (!kek)
    throw new TokenRefreshEnvError(
      'INTEGRATIONS_TOKEN_KEK must be 32 bytes (base64) when refresh is enabled',
    );
  return { enabled, intervalMs, kek };
}

function apiOriginOrThrow(env: NodeJS.ProcessEnv): string {
  try {
    return integrationsApiOrigin(env);
  } catch (err) {
    if (err instanceof IntegrationsApiOriginError) throw new TokenRefreshEnvError(err.message);
    throw err;
  }
}

/** Strict: canonical base64 of 32 bytes, refused under NODE_ENV=production (ADR-008). Names the key only. */
export function parseKek(env: NodeJS.ProcessEnv): Buffer | undefined {
  try {
    return parseSharedKek(env);
  } catch (err) {
    if (err instanceof SharedKekError) throw new TokenRefreshEnvError(err.message);
    throw err;
  }
}

/** Providers from the same env the API uses (integrationsRuntimeFromEnv); an unconfigured provider is skipped. */
export function tokenRefreshProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => Promise<string> = (p) =>
    import('node:fs/promises').then((fs) => fs.readFile(p, 'utf8')),
): TokenRefreshProviders {
  const providers: TokenRefreshProviders = {};
  const jiraId = env.JIRA_CLIENT_ID?.trim();
  const jiraSecret = env.JIRA_CLIENT_SECRET;
  if (jiraId && jiraSecret) {
    const apiOrigin = apiOriginOrThrow(env);
    providers.jira = new JiraOAuthClient({
      clientId: jiraId,
      clientSecret: async () => jiraSecret,
      redirectUriAllowlist: [`${apiOrigin}/integrations/jira/callback`],
      stateStore: new InMemoryOAuthStateStore(),
    });
  }
  const appId = env.GITHUB_APP_ID?.trim();
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  const ghClientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const ghClientSecret = env.GITHUB_APP_CLIENT_SECRET;
  if (appId && keyFile && ghClientId && ghClientSecret) {
    providers.github = new GitHubAppClient({
      appId,
      clientId: ghClientId,
      privateKey: () => readFile(keyFile),
      clientSecret: async () => ghClientSecret,
    });
  }
  return providers;
}

/** Logs a Redis outage once (error name only) until the connection is ready again; ioredis keeps reconnecting. */
export function watchLeaseRedis(
  redis: { on(event: string, fn: (err?: unknown) => void): unknown },
  log: TokenRefreshLog,
): void {
  let down = false;
  redis.on('error', (err: unknown) => {
    if (down) return;
    down = true;
    log.warn(
      { errName: err instanceof Error ? err.name : 'unknown' },
      'integration token refresh lease redis unavailable',
    );
  });
  redis.on('ready', () => {
    if (down) log.info({}, 'integration token refresh lease redis reconnected');
    down = false;
  });
}

export type TokenRefreshRegistration =
  | { registered: false; reason: 'disabled' }
  | { registered: true; close: () => Promise<void>; tick: () => Promise<void> };

export const TOKEN_REFRESH_QUEUE = 'integrations-token-refresh';
export const TOKEN_REFRESH_SCHEDULER_ID = 'integrations-token-refresh-sweep';

/** Minimal BullMQ Queue surface; upsertJobScheduler is idempotent across replicas (one scheduler per id). */
export interface TokenRefreshQueuePort {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data?: unknown; opts?: Record<string, unknown> },
  ): Promise<unknown>;
  close(): Promise<void>;
}
export interface TokenRefreshWorkerPort {
  close(): Promise<void>;
}
export interface TokenRefreshQueueFactories {
  queue: () => TokenRefreshQueuePort;
  worker: (process: () => Promise<unknown>) => TokenRefreshWorkerPort;
}

const bullmqFactories: TokenRefreshQueueFactories = {
  queue: () => createQueue(TOKEN_REFRESH_QUEUE),
  // concurrency 1: a replica never runs two sweeps at once.
  worker: (process) => createWorker(TOKEN_REFRESH_QUEUE, () => process(), { concurrency: 1 }),
};

/**
 * Token refresh on one BullMQ job scheduler: every replica upserts the SAME scheduler id, so Redis holds one
 * repeatable job and each tick is delivered to one worker, instead of one setInterval per replica. That alone does
 * not stop sweeps overlapping across replicas (the next run is queued as a sweep starts, and a stalled job whose
 * lock expires can run alongside it). What makes overlap safe is the per-connection lease in runTokenRefreshSweep
 * (Jira rotates refresh tokens, so two concurrent refreshes of one connection could burn the grant), backed by the
 * database fence on every write.
 */
export function startTokenRefreshQueueScheduler(
  deps: TokenRefreshDeps,
  opts: { intervalMs: number; factories?: TokenRefreshQueueFactories },
): { close: () => Promise<void>; tick: () => Promise<void> } {
  const f = opts.factories ?? bullmqFactories;
  const sweep = () =>
    runTokenRefreshSweep(deps).catch((err: unknown) => {
      deps.log.warn(
        { errName: err instanceof Error ? err.name : 'unknown' },
        'integration token refresh sweep failed',
      );
      throw err;
    });
  const queue = f.queue();
  const worker = f.worker(sweep);
  void queue
    .upsertJobScheduler(
      TOKEN_REFRESH_SCHEDULER_ID,
      { every: opts.intervalMs },
      { name: 'sweep', data: {}, opts: { attempts: 1, removeOnComplete: 12, removeOnFail: 24 } },
    )
    .catch((err: unknown) =>
      deps.log.warn(
        { errName: err instanceof Error ? err.name : 'unknown' },
        'integration token refresh schedule failed',
      ),
    );
  return {
    tick: () => sweep().then(() => undefined),
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}

export interface RegisterTokenRefreshOptions {
  env: TokenRefreshEnv;
  log: TokenRefreshLog;
  /** Test seam; defaults to the Prisma repository + env providers. */
  buildDeps?: (env: TokenRefreshEnv & { kek: Buffer }) => Omit<TokenRefreshDeps, 'log'>;
  start?: typeof startTokenRefreshQueueScheduler;
}

function createLeaseRedis(log: TokenRefreshLog): ReturnType<typeof createRedisClient> {
  const redis = createRedisClient(LEASE_REDIS_OPTIONS);
  watchLeaseRedis(redis, log);
  return redis;
}

/** Integrations token-refresh job for apps/worker main(): one BullMQ job scheduler + a per-connection lease. */
export function registerTokenRefreshJob(
  opts: RegisterTokenRefreshOptions,
): TokenRefreshRegistration {
  if (!opts.env.enabled || !opts.env.kek) return { registered: false, reason: 'disabled' };
  const env = { ...opts.env, kek: opts.env.kek };
  let leaseRedis: ReturnType<typeof createRedisClient> | undefined;
  const deps =
    opts.buildDeps?.(env) ??
    ({
      repo: createIntegrationConnectionRepository({
        cipher: new TokenCipher(new LocalKeyProvider({ shared: env.kek }, 'shared')),
      }),
      providers: tokenRefreshProvidersFromEnv(),
      lease: createRedisConnectionLease((leaseRedis = createLeaseRedis(opts.log))),
    } satisfies Omit<TokenRefreshDeps, 'log'>);
  const scheduler = (opts.start ?? startTokenRefreshQueueScheduler)(
    { ...deps, log: opts.log },
    { intervalMs: env.intervalMs },
  );
  return {
    registered: true,
    tick: scheduler.tick,
    close: async () => {
      await scheduler.close();
      await leaseRedis?.quit().catch(() => undefined);
    },
  };
}
