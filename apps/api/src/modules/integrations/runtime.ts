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
