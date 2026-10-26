import type { Id, IntegrationProvider } from '@meetops/contracts';
import type { ApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/client';

/**
 * GitHub / Jira integration settings. DEPENDENCY: contracts 0.4.1 only defines `IntegrationProvider` and
 * `IntegrationIssue`; there are no integration-settings DTOs or routes yet (All Rounder, backend stream). These local
 * types are the proposed shape; the UI runs on the typed in-memory mock (`createMockIntegrationsApi`) until then.
 * Secrets never touch the web app: connecting is an OAuth redirect the server starts.
 */
export type IntegrationStatus = 'connected' | 'disconnected' | 'error';
export type IntegrationDto = {
  id: Id | null;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** GitHub org/user login or Jira site host. */
  accountLabel: string | null;
  /** 'owner/repo' (GitHub) or project key (Jira) new tasks are filed into. */
  defaultTarget: string | null;
  connectedAt: string | null;
  lastError: string | null;
};
export type ConnectIntegrationResponse = { authorizeUrl: string };
export type UpdateIntegrationRequest = { defaultTarget: string | null };

export interface IntegrationsApi {
  list(organizationId: Id): Promise<{ items: IntegrationDto[] }>;
  connect(organizationId: Id, provider: IntegrationProvider): Promise<ConnectIntegrationResponse>;
  update(
    organizationId: Id,
    provider: IntegrationProvider,
    body: UpdateIntegrationRequest,
  ): Promise<IntegrationDto>;
  disconnect(organizationId: Id, provider: IntegrationProvider): Promise<void>;
}

const base = (o: Id) => `/orgs/${encodeURIComponent(o)}/integrations`;
export const INTEGRATIONS_PATHS = {
  list: base,
  connect: (o: Id, p: IntegrationProvider) => `${base(o)}/${p}/connect`,
  item: (o: Id, p: IntegrationProvider) => `${base(o)}/${p}`,
} as const;

export function createHttpIntegrationsApi(request: ApiClient['request']): IntegrationsApi {
  return {
    list: (o) => request('GET', INTEGRATIONS_PATHS.list(o)),
    connect: (o, p) => request('POST', INTEGRATIONS_PATHS.connect(o, p)),
    update: (o, p, body) => request('PATCH', INTEGRATIONS_PATHS.item(o, p), body),
    disconnect: (o, p) => request('DELETE', INTEGRATIONS_PATHS.item(o, p)),
  };
}

export const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}$/;

export function validateTarget(provider: IntegrationProvider, v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (provider === 'github')
    return GITHUB_REPO_RE.test(t) ? null : 'Use the owner/repo format, for example acme/web.';
  return JIRA_KEY_RE.test(t)
    ? null
    : 'Use a project key such as OPS (2–10 capital letters or digits).';
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

/** In-memory mock: same rules the UI relies on (422 on a bad target, 409 when not connected). */
export function createMockIntegrationsApi(
  seed: Partial<Record<IntegrationProvider, Partial<IntegrationDto>>> = {},
): IntegrationsApi {
  const blank = (provider: IntegrationProvider): IntegrationDto => ({
    id: null,
    provider,
    status: 'disconnected',
    accountLabel: null,
    defaultTarget: null,
    connectedAt: null,
    lastError: null,
    ...seed[provider],
  });
  const state: Record<IntegrationProvider, IntegrationDto> = {
    github: blank('github'),
    jira: blank('jira'),
  };
  return {
    list: () => Promise.resolve({ items: [{ ...state.github }, { ...state.jira }] }),
    connect: (_o, p) =>
      Promise.resolve({ authorizeUrl: `https://example.com/oauth/${p}/authorize?state=mock` }),
    update: (_o, p, body) => {
      if (state[p].status !== 'connected')
        return Promise.reject(new ApiError(409, 'CONFLICT', 'Not connected'));
      if (body.defaultTarget && validateTarget(p, body.defaultTarget))
        return Promise.reject(
          new ApiError(422, 'VALIDATION_FAILED', 'Invalid', undefined, [
            { path: '/defaultTarget', message: 'invalid' },
          ]),
        );
      state[p] = { ...state[p], defaultTarget: body.defaultTarget };
      return Promise.resolve({ ...state[p] });
    },
    disconnect: (_o, p) => {
      state[p] = {
        ...blank(p),
        status: 'disconnected',
        id: null,
        accountLabel: null,
        defaultTarget: null,
        connectedAt: null,
        lastError: null,
      };
      return Promise.resolve();
    },
  };
}

let override: IntegrationsApi | null = null;
/** Dev (VITE_INTEGRATION_MOCKS=true) and tests swap in the mock here. */
export function setIntegrationsApiOverride(api: IntegrationsApi | null): void {
  override = api;
}
export function getIntegrationsApi(request: ApiClient['request']): IntegrationsApi {
  return override ?? createHttpIntegrationsApi(request);
}
