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
import { createQueue, createWorker } from '@meetops/queue';
import {
  runTokenRefreshSweep,
  type TokenRefreshDeps,
  type TokenRefreshLog,
  type TokenRefreshProviders,
} from './token-refresh.js';

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
  if (!kek)
    throw new TokenRefreshEnvError(
      'INTEGRATIONS_TOKEN_KEK must be 32 bytes (base64) when refresh is enabled',
    );
  return { enabled, intervalMs, kek };
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
    const apiOrigin = env.INTEGRATIONS_API_ORIGIN?.trim() || 'http://localhost:4000';
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
 * Single-replica token refresh (Jira rotates refresh tokens, so concurrent sweeps can invalidate each other's
 * grant). Every replica upserts the SAME BullMQ job scheduler id, so Redis holds exactly one repeatable job and
 * each tick is delivered to exactly one worker, instead of one setInterval per replica.
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

/** Integrations token-refresh job for apps/worker main(); single-replica via a BullMQ job scheduler. */
export function registerTokenRefreshJob(
  opts: RegisterTokenRefreshOptions,
): TokenRefreshRegistration {
  if (!opts.env.enabled || !opts.env.kek) return { registered: false, reason: 'disabled' };
  const env = { ...opts.env, kek: opts.env.kek };
  const deps =
    opts.buildDeps?.(env) ??
    ({
      repo: createIntegrationConnectionRepository({
        cipher: new TokenCipher(new LocalKeyProvider({ shared: env.kek }, 'shared')),
      }),
      providers: tokenRefreshProvidersFromEnv(),
    } satisfies Omit<TokenRefreshDeps, 'log'>);
  const scheduler = (opts.start ?? startTokenRefreshQueueScheduler)(
    { ...deps, log: opts.log },
    { intervalMs: env.intervalMs },
  );
  return { registered: true, close: scheduler.close, tick: scheduler.tick };
}
