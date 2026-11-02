import type { FetchLike } from './jira.js';
import { withRequestDeadline } from './request-deadline.js';
import {
  assertAllowedRedirect,
  createPkcePair,
  OAuthStateManager,
  type OAuthStateStore,
} from './oauth-state.js';

export const ATLASSIAN_AUTHORIZE_URL = 'https://auth.atlassian.com/authorize';
export const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
export const ATLASSIAN_ACCESSIBLE_RESOURCES_URL =
  'https://api.atlassian.com/oauth/token/accessible-resources';

/** Minimal classic scopes for issue create/read/transition + refresh. Do not widen without Security review. */
export const JIRA_OAUTH_SCOPES = Object.freeze([
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'offline_access',
] as const);

export class JiraOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    // Never include tokens, codes, client secrets or upstream bodies.
    super(`Jira OAuth failed: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'JiraOAuthError';
  }
}

export interface JiraOAuthOptions {
  clientId: string;
  /** Resolved per call from the secret manager; never stored on the instance. */
  clientSecret: () => Promise<string>;
  /** Exact redirect URIs registered in the Atlassian developer console. */
  redirectUriAllowlist: readonly string[];
  stateStore: OAuthStateStore;
  stateTtlSeconds?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Require a new refresh token on every refresh (Atlassian rotating refresh tokens). Default true. */
  requireRefreshRotation?: boolean;
}

export interface JiraAccessibleResource {
  cloudId: string;
  url: string;
  name: string;
  scopes: string[];
}

export interface JiraOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

export interface JiraOAuthConnection extends JiraOAuthTokens {
  /** Set when exactly one Jira site is accessible (or the requested one matched); otherwise caller must pick from resources. */
  cloudId?: string;
  siteUrl?: string;
  /** API gateway base URL for JiraIssueTrackerProvider. */
  baseUrl?: string;
  resources: JiraAccessibleResource[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Za-z0-9._~-]{1,2048}$/;

/** Granted scopes must include every required scope and nothing outside the allowed set. */
export function validateGrantedScopes(
  granted: string | string[] | undefined,
  required: readonly string[] = JIRA_OAUTH_SCOPES,
  allowed: readonly string[] = required,
): string[] {
  const list = (Array.isArray(granted) ? granted : (granted ?? '').split(/\s+/)).filter(Boolean);
  const missing = required.filter((s) => !list.includes(s));
  if (missing.length) throw new JiraOAuthError('insufficient_scope');
  const extra = list.filter((s) => !allowed.includes(s));
  if (extra.length) throw new JiraOAuthError('excess_scope');
  return [...new Set(list)].sort();
}

export class JiraOAuthClient {
  private readonly state: OAuthStateManager;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: JiraOAuthOptions) {
    if (!opts.clientId) throw new Error('clientId is required');
    if (!opts.redirectUriAllowlist.length) throw new Error('redirectUriAllowlist is required');
    for (const r of opts.redirectUriAllowlist) assertAllowedRedirect(r, opts.redirectUriAllowlist);
    this.now = opts.now ?? Date.now;
    this.state = new OAuthStateManager(opts.stateStore, {
      ttlSeconds: opts.stateTtlSeconds ?? 600,
      now: this.now,
    });
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  /** Step 1: returns the Atlassian consent URL. The PKCE verifier stays server-side in the state record. */
  async beginAuthorization(input: {
    organizationId: string;
    userId: string;
    redirectUri: string;
  }): Promise<{ url: string; state: string }> {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    const pkce = createPkcePair();
    const state = await this.state.issue({ provider: 'jira', ...input }, pkce.codeVerifier);
    const u = new URL(ATLASSIAN_AUTHORIZE_URL);
    u.search = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: this.opts.clientId,
      scope: JIRA_OAUTH_SCOPES.join(' '),
      redirect_uri: input.redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), state };
  }

  /** Step 2 (callback): consume state, exchange code (+verifier), validate scopes, look up cloudId. */
  async completeAuthorization(input: {
    state: unknown;
    code: unknown;
    organizationId: string;
    userId: string;
    redirectUri: string;
    cloudId?: string;
  }): Promise<JiraOAuthConnection> {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    const rec = await this.state.consume(input.state, {
      provider: 'jira',
      organizationId: input.organizationId,
      userId: input.userId,
      redirectUri: input.redirectUri,
    });
    if (typeof input.code !== 'string' || !CODE_RE.test(input.code))
      throw new JiraOAuthError('invalid_code');
    if (!rec.codeVerifier) throw new JiraOAuthError('missing_verifier');
    const tokens = await this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: rec.redirectUri,
        code_verifier: rec.codeVerifier,
      },
      true,
    );
    const resources = await this.accessibleResources(tokens.accessToken);
    const conn: JiraOAuthConnection = { ...tokens, resources };
    const pick = input.cloudId
      ? resources.find((r) => r.cloudId === input.cloudId)
      : resources.length === 1
        ? resources[0]
        : undefined;
    if (input.cloudId && !pick) throw new JiraOAuthError('cloud_not_accessible');
    if (pick)
      Object.assign(conn, {
        cloudId: pick.cloudId,
        siteUrl: pick.url,
        baseUrl: `https://api.atlassian.com/ex/jira/${pick.cloudId}`,
      });
    return conn;
  }

  /**
   * Refresh with rotation: Atlassian returns a NEW refresh token and invalidates the old one. Persist the returned
   * pair atomically (compare-and-swap on the old ciphertext) before using it; never retry with the old token.
   */
  async refresh(
    refreshToken: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<JiraOAuthTokens> {
    if (!refreshToken) throw new JiraOAuthError('missing_refresh_token');
    const t = await this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      this.opts.requireRefreshRotation ?? true,
      opts.signal,
    );
    if (!t.refreshToken) return { ...t, refreshToken };
    if ((this.opts.requireRefreshRotation ?? true) && t.refreshToken === refreshToken)
      throw new JiraOAuthError('refresh_not_rotated');
    return t;
  }

  /** GET accessible-resources; keeps only Jira sites with valid cloudId + https *.atlassian.net url. */
  async accessibleResources(accessToken: string): Promise<JiraAccessibleResource[]> {
    const body = await this.call(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!Array.isArray(body)) throw new JiraOAuthError('invalid_resources');
    return body.flatMap((r: { id?: unknown; url?: unknown; name?: unknown; scopes?: unknown }) => {
      if (typeof r?.id !== 'string' || !UUID_RE.test(r.id) || typeof r.url !== 'string') return [];
      let host: string;
      try {
        const u = new URL(r.url);
        if (u.protocol !== 'https:') return [];
        host = u.hostname;
      } catch {
        return [];
      }
      if (!/^[a-z0-9-]+\.atlassian\.net$/i.test(host)) return [];
      const scopes = Array.isArray(r.scopes)
        ? r.scopes.filter((s): s is string => typeof s === 'string')
        : [];
      if (!scopes.some((s) => s.includes('jira'))) return [];
      return [
        {
          cloudId: r.id.toLowerCase(),
          url: `https://${host.toLowerCase()}`,
          name: typeof r.name === 'string' ? r.name.slice(0, 200) : '',
          scopes,
        },
      ];
    });
  }

  private async tokenRequest(
    params: Record<string, string>,
    requireRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<JiraOAuthTokens> {
    const body = await this.call(
      ATLASSIAN_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          ...params,
          client_id: this.opts.clientId,
          client_secret: await this.opts.clientSecret(),
        }),
      },
      signal,
    );
    const b = body as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
      token_type?: unknown;
    };
    if (typeof b?.access_token !== 'string' || !b.access_token)
      throw new JiraOAuthError('invalid_token_response');
    if (typeof b.token_type === 'string' && b.token_type.toLowerCase() !== 'bearer')
      throw new JiraOAuthError('invalid_token_type');
    const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
    if (requireRefresh && (typeof b.refresh_token !== 'string' || !b.refresh_token))
      throw new JiraOAuthError('missing_refresh_token');
    const scopes = validateGrantedScopes(typeof b.scope === 'string' ? b.scope : undefined);
    return {
      accessToken: b.access_token,
      refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : '',
      expiresAt: this.now() + expiresIn * 1000,
      scopes,
    };
  }

  /**
   * No retries (authorization codes and rotating refresh tokens are single-use), no redirects, sanitized errors. One
   * timeout covers the request AND reading the body; the caller's `signal` (e.g. the token-refresh sweep's deadline)
   * aborts it too.
   */
  private async call(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return withRequestDeadline(
      this.opts.timeoutMs ?? 10_000,
      signal,
      () => new JiraOAuthError('timeout'),
      async (abort) => {
        let res: Awaited<ReturnType<FetchLike>>;
        try {
          res = await this.fetchFn(url, { ...init, redirect: 'error', signal: abort });
        } catch (err) {
          throw new JiraOAuthError(
            (err as { name?: string }).name === 'AbortError' ? 'timeout' : 'network_error',
          );
        }
        const text = await res.text().catch(() => '');
        if (text.length > 256 * 1024) throw new JiraOAuthError('response_too_large', res.status);
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          throw new JiraOAuthError('invalid_json', res.status);
        }
        if (!res.ok) {
          const e = (json as { error?: unknown } | undefined)?.error;
          throw new JiraOAuthError(
            typeof e === 'string' && /^[a-z_]{1,64}$/.test(e) ? e : 'http_error',
            res.status,
          );
        }
        return json;
      },
    );
  }
}

/** Credential for JiraIssueTrackerProvider (CredentialResolver result). */
export function toJiraOAuthCredential(tokens: Pick<JiraOAuthTokens, 'accessToken'>) {
  return { kind: 'jira-oauth' as const, accessToken: tokens.accessToken };
}
