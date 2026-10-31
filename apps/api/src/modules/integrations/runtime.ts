import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  InMemoryDeliveryStore,
  InMemoryOAuthStateStore,
  LocalKeyProvider,
  TokenCipher,
  constantTimeEqual,
  type DeliveryStore,
  type FetchLike,
  type OAuthStateStore,
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
  // Ignored unless it decodes to exactly 32 bytes; the random per-process key stays the default.
  const kek = env.INTEGRATIONS_TOKEN_KEK?.trim();
  if (kek) {
    const buf = Buffer.from(kek, 'base64');
    if (buf.length === 32)
      over.cipher = new TokenCipher(new LocalKeyProvider({ shared: buf }, 'shared'));
  }
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
  return over;
}
