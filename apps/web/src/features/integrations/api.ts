import { INTEGRATION_PATHS } from '@meetops/contracts/types';
import type {
  ConnectIntegrationResponse,
  Id,
  Integration,
  IntegrationList,
  IntegrationProvider,
} from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';
import { fillPath } from '@/features/uploads/types';

/**
 * GitHub / Jira integrations on the contracts 0.8.0 routes (#223). Secrets never touch the web app:
 * connecting is an OAuth redirect the server starts (#226), so it stays behind VITE_INTEGRATION_CONNECT
 * until those routes ship.
 */
export type { ConnectIntegrationResponse, Integration, IntegrationList };
export { INTEGRATION_PATHS };

export const PROVIDERS: readonly IntegrationProvider[] = ['github', 'jira'];
/** Where the OAuth callback sends the user back to. */
export const CONNECT_RETURN_TO = '/settings?tab=integrations';

export interface IntegrationsApi {
  list(organizationId: Id): Promise<IntegrationList>;
  connect(organizationId: Id, provider: IntegrationProvider): Promise<ConnectIntegrationResponse>;
  disconnect(organizationId: Id, integrationId: Id): Promise<unknown>;
}

export function createHttpIntegrationsApi(request: ApiClient['request']): IntegrationsApi {
  return {
    list: (o) => request('GET', fillPath(INTEGRATION_PATHS.integrations, { organizationId: o })),
    connect: (o, provider) =>
      request('POST', fillPath(INTEGRATION_PATHS.connect, { organizationId: o }), {
        provider,
        returnTo: CONNECT_RETURN_TO,
      }),
    // #223 answers 200 with the revoked Integration (contracts document 204); either is fine here.
    disconnect: (o, id) =>
      request(
        'DELETE',
        fillPath(INTEGRATION_PATHS.integration, { organizationId: o, integrationId: id }),
      ),
  };
}

/** Connect is off until the #226 connect routes merge; flip with VITE_INTEGRATION_CONNECT=true. */
export function isConnectEnabled(): boolean {
  return import.meta.env.VITE_INTEGRATION_CONNECT === 'true';
}

/** The newest non-revoked connection per provider (revoked rows are history only). */
export function currentByProvider(
  items: readonly Integration[],
): Record<IntegrationProvider, Integration | null> {
  const out: Record<IntegrationProvider, Integration | null> = { github: null, jira: null };
  for (const i of items) {
    if (i.status === 'revoked') continue;
    const prev = out[i.provider];
    if (!prev || prev.updatedAt < i.updatedAt) out[i.provider] = i;
  }
  return out;
}

/** Only follow an https authorize URL the server returned (no javascript:, no plain http). */
export function safeAuthorizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** In-memory mock for dev (VITE_INTEGRATION_MOCKS=true) and tests. */
export function createMockIntegrationsApi(seed: Integration[] = []): IntegrationsApi {
  let state = [...seed];
  return {
    list: () => Promise.resolve({ items: state.map((i) => ({ ...i })) }),
    connect: (_o, p) =>
      Promise.resolve({
        authorizeUrl: `https://example.com/oauth/${p}/authorize?state=mock`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    disconnect: (_o, id) => {
      state = state.map((i) =>
        i.id === id ? { ...i, status: 'revoked', updatedAt: new Date().toISOString() } : i,
      );
      return Promise.resolve(state.find((i) => i.id === id));
    },
  };
}

let override: IntegrationsApi | null = null;
export function setIntegrationsApiOverride(api: IntegrationsApi | null): void {
  override = api;
}
export function getIntegrationsApi(request: ApiClient['request']): IntegrationsApi {
  return override ?? createHttpIntegrationsApi(request);
}
