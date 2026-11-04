import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  InMemoryDeliveryStore,
  InMemoryOAuthStateStore,
  LocalKeyProvider,
  parseOutlookTenant,
  parseSharedKek,
  TokenCipher,
  constantTimeEqual,
  type ConnectionLease,
  type DeliveryStore,
  type FetchLike,
  type LeaseRedis,
  type OAuthStateStore,
  type RedisSetNxClient,
} from '@meetops/integrations';
import type { IntegrationSecretCipher } from '@meetops/database';

/**
 * Everything the connect/callback/webhook/push routes need that is secret or deployment specific (ADR-008).
 * Injected as `deps.integrationsRuntime`. Dev/test get `devIntegrationsRuntime()` (random keys, in-memory stores);
 * production without one keeps list/disconnect and answers the other routes with 503 PROVIDER_UNAVAILABLE.
 * Env var names for the KEK and provider secrets are parked (ADR-008 secret manager).
 */
export interface IntegrationsRuntime {
  cipher: IntegrationSecretCipher;
  /** Single-use OAuth/App-install state (Redis `SET EX NX` + `GETDEL` in production). */
  stateStore: OAuthStateStore;
  /** >= 32 bytes. MACs the state so forged/garbled states are rejected before any store lookup. */
  stateSigningKey: Buffer;
  /** Webhook replay marks (Redis in production; InMemoryDeliveryStore refuses production). */
  deliveryStore: DeliveryStore;
  /** https web origin the callback redirects to, e.g. https://app.meetops.example */
  webOrigin: string;
  /** Public API origin used to build callback URLs (registered at the provider). */
  apiOrigin: string;
  fetch?: FetchLike;
  now?: () => number;
  /**
   * Per-connection token-refresh lease shared with the worker sweep (Redis in production, wired from deps.redis by
   * the module; outside development/test without Redis it is a refusing lease, so Jira refresh fails closed).
   * Absent only in development/test without Redis, where the fenced save alone guards the write.
   */
  tokenRefreshLease?: ConnectionLease;
  /** Test hook for the wait while another holder refreshes. */
  sleep?: (ms: number) => Promise<void>;
  github?: {
    appSlug: string;
    appId: string;
    clientId: string;
    privateKey: () => Promise<string>;
    clientSecret: () => Promise<string>;
    /** App-wide webhook secret (GitHub Apps have one webhook URL/secret per App). */
    webhookSecret: () => Promise<string>;
  };
  jira?: { clientId: string; clientSecret: () => Promise<string> };
  /** Phase 7: Google Calendar OAuth client (read-only scopes). Absent = calendar connect answers 503. */
  googleCalendar?: { clientId: string; clientSecret: () => Promise<string> };
  /** Phase 7: Microsoft Outlook (Graph) OAuth client, read-only scopes. Absent = connect answers 503. */
  outlookCalendar?: { clientId: string; clientSecret: () => Promise<string>; tenant?: string };
}

export function devIntegrationsRuntime(
  over: Partial<IntegrationsRuntime> = {},
): IntegrationsRuntime {
  return {
    cipher: new TokenCipher(new LocalKeyProvider({ dev: randomBytes(32) }, 'dev')),
    stateStore: new InMemoryOAuthStateStore(),
    stateSigningKey: randomBytes(32),
    deliveryStore: new InMemoryDeliveryStore({ nodeEnv: process.env.NODE_ENV ?? 'development' }),
    webOrigin: 'http://localhost:3000',
    apiOrigin: 'http://localhost:4000',
    ...over,
  };
}

const MAC_LABEL = 'meetops-oauth-state|';
const INNER_LEN = 43;
const RETURN_TO_PREFIX = 'rt:';

/** State on the wire = library state (43 chars, single-use, expiring) + 43-char HMAC-SHA256 tag = 86 chars. */
export function signState(key: Buffer, inner: string): string {
  return (
    inner +
    createHmac('sha256', key)
      .update(MAC_LABEL + inner)
      .digest('base64url')
  );
}

/** Returns the inner (library) state, or null when the MAC does not verify (constant-time compare). */
export function verifySignedState(key: Buffer, state: string): string | null {
  if (state.length !== INNER_LEN * 2) return null;
  const inner = state.slice(0, INNER_LEN);
  return constantTimeEqual(signState(key, inner), state) ? inner : null;
}

const rtKey = (inner: string) =>
  RETURN_TO_PREFIX + createHash('sha256').update(inner).digest('base64url');

export async function putReturnTo(
  store: OAuthStateStore,
  inner: string,
  returnTo: string,
  ttl: number,
) {
  await store.put(rtKey(inner), returnTo, ttl);
}

export async function takeReturnTo(store: OAuthStateStore, inner: string): Promise<string | null> {
  return store.take(rtKey(inner));
}

/**
 * Dev-only: overlay real provider apps from env onto `devIntegrationsRuntime()` so a developer can connect a real
 * GitHub App / Jira OAuth app locally (docs/runbooks/integrations-real-setup.md). Secrets are read lazily and never
 * logged. Production still requires an injected runtime (ADR-008 secret manager); this is not used there.
 */
export function integrationsRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => Promise<string> = (p) =>
    import('node:fs/promises').then((fs) => fs.readFile(p, 'utf8')),
): Partial<IntegrationsRuntime> {
  const over: Partial<IntegrationsRuntime> = {};
  if (env.INTEGRATIONS_API_ORIGIN) over.apiOrigin = env.INTEGRATIONS_API_ORIGIN;
  if (env.INTEGRATIONS_WEB_ORIGIN) over.webOrigin = env.INTEGRATIONS_WEB_ORIGIN;
  // Shared dev KEK so apps/worker (token refresh) can decrypt what the API sealed. Same key id as the worker.
  // Unset keeps the random per-process key. Set but invalid, or set with NODE_ENV=production, throws at startup.
  const kek = parseSharedKek(env);
  if (kek) over.cipher = new TokenCipher(new LocalKeyProvider({ shared: kek }, 'shared'));
  const g = {
    appId: env.GITHUB_APP_ID,
    appSlug: env.GITHUB_APP_SLUG,
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    keyFile: env.GITHUB_APP_PRIVATE_KEY_FILE,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  };
  if (Object.values(g).every(Boolean)) {
    const clientSecret = g.clientSecret!;
    const webhookSecret = g.webhookSecret!;
    const keyFile = g.keyFile!;
    over.github = {
      appId: g.appId!,
      appSlug: g.appSlug!,
      clientId: g.clientId!,
      privateKey: () => readFile(keyFile),
      clientSecret: async () => clientSecret,
      webhookSecret: async () => webhookSecret,
    };
  }
  if (env.JIRA_CLIENT_ID && env.JIRA_CLIENT_SECRET) {
    const secret = env.JIRA_CLIENT_SECRET;
    over.jira = { clientId: env.JIRA_CLIENT_ID, clientSecret: async () => secret };
  }
  if (env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET) {
    const secret = env.GOOGLE_CALENDAR_CLIENT_SECRET;
    over.googleCalendar = {
      clientId: env.GOOGLE_CALENDAR_CLIENT_ID,
      clientSecret: async () => secret,
    };
  }
  // Validated even without a client: a malformed tenant fails startup (OutlookTenantError), not the first connect.
  const tenant = parseOutlookTenant(env.OUTLOOK_CALENDAR_TENANT);
  if (env.OUTLOOK_CALENDAR_CLIENT_ID && env.OUTLOOK_CALENDAR_CLIENT_SECRET) {
    const secret = env.OUTLOOK_CALENDAR_CLIENT_SECRET;
    over.outlookCalendar = {
      clientId: env.OUTLOOK_CALENDAR_CLIENT_ID,
      clientSecret: async () => secret,
      ...(tenant ? { tenant } : {}),
    };
  }
  return over;
}

/** SET NX PX in one atomic script: the API's RedisLike has no NX `set` overload. Returns 'OK' or nil. */
export const ACQUIRE_LEASE_LUA = `return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')`;

/** Adapts the API's eval-capable Redis client to the shared lease (createRedisConnectionLease). */
/**
 * Adapts the API's shared ioredis client (REDIS_CLIENT_OPTIONS, commandTimeout set) to RedisDeliveryStore using
 * EVAL only, so RedisLike does not need an EX/NX SET overload.
 */
export function deliveryRedisFromEval(redis: {
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}): RedisSetNxClient {
  return {
    async set(key, value, _ex, ttl) {
      const r = await redis.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')",
        1,
        key,
        value,
        String(ttl),
      );
      return r === 'OK' ? 'OK' : null;
    },
    eval: (script, numKeys, ...args) => redis.eval(script, numKeys, ...args),
  };
}

export function leaseRedisFromEval(redis: {
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}): LeaseRedis {
  return {
    async set(key, value, _px, ttlMs) {
      const r = await redis.eval(ACQUIRE_LEASE_LUA, 1, key, value, String(ttlMs));
      return r === 'OK' ? 'OK' : null;
    },
    eval: (script, numKeys, ...args) => redis.eval(script, numKeys, ...args),
  };
}

/** Outside development/test without Redis: every acquire fails, so no refresh runs without the shared lease. */
export const refusingTokenRefreshLease: ConnectionLease = {
  acquire: () => Promise.reject(new Error('token refresh lease requires Redis')),
  confirm: () => Promise.resolve(false),
  release: () => Promise.resolve(false),
};
