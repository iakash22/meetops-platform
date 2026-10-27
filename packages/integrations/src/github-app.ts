import { createSign } from 'node:crypto';
import type { FetchLike } from './jira.js';
import type { GitHubIssueData, GitHubIssuesClient } from './github.js';

/**
 * GitHub App server-side auth over plain fetch (no SDK): App JWT (RS256), installation lookup, installation
 * access tokens, and the user-to-server check that the installing user can access the installation.
 * Errors carry a code and HTTP status only, never tokens, codes, keys or upstream bodies.
 */
export class GitHubAppError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(`GitHub App request failed: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'GitHubAppError';
  }
}

const API = 'https://api.github.com';
const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** RS256 App JWT: iat backdated 60s for clock drift, exp 9 minutes (GitHub caps it at 10). */
export function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMs: number = Date.now(),
): string {
  if (!/^\d{1,20}$/.test(appId)) throw new GitHubAppError('invalid_app_id');
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  let sig: Buffer;
  try {
    sig = signer.sign(privateKeyPem);
  } catch {
    throw new GitHubAppError('invalid_private_key');
  }
  return `${head}.${body}.${b64u(sig)}`;
}

export interface GitHubAppOptions {
  appId: string;
  /** PEM, resolved per call from the secret manager; never stored on the instance. */
  privateKey: () => Promise<string>;
  /** GitHub App OAuth client id/secret, for the user-to-server installation check. */
  clientId: string;
  clientSecret: () => Promise<string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface GitHubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
}

const CODE_RE = /^[A-Za-z0-9_-]{1,512}$/;
const ID_RE = /^[1-9]\d{0,19}$/;

export class GitHubAppClient {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  constructor(private readonly opts: GitHubAppOptions) {
    if (!/^\d{1,20}$/.test(opts.appId)) throw new Error('Invalid GitHub App id');
    if (!opts.clientId) throw new Error('clientId is required');
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  private async appJwt(): Promise<string> {
    return createGitHubAppJwt(this.opts.appId, await this.opts.privateKey(), this.now());
  }

  /** Confirms the (untrusted) installation id belongs to this App. */
  async getInstallation(installationId: string): Promise<GitHubInstallation> {
    if (!ID_RE.test(installationId)) throw new GitHubAppError('invalid_installation_id');
    const b = (await this.call(
      `${API}/app/installations/${installationId}`,
      'GET',
      `Bearer ${await this.appJwt()}`,
    )) as {
      id?: unknown;
      account?: { login?: unknown; type?: unknown } | null;
    };
    if (String(b?.id) !== installationId || typeof b.account?.login !== 'string')
      throw new GitHubAppError('invalid_installation');
    return {
      id: installationId,
      accountLogin: b.account.login.slice(0, 200),
      accountType: typeof b.account.type === 'string' ? b.account.type : 'User',
    };
  }

  /** Short-lived (1h) installation access token. */
  async createInstallationToken(
    installationId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    if (!ID_RE.test(installationId)) throw new GitHubAppError('invalid_installation_id');
    const b = (await this.call(
      `${API}/app/installations/${installationId}/access_tokens`,
      'POST',
      `Bearer ${await this.appJwt()}`,
    )) as {
      token?: unknown;
      expires_at?: unknown;
    };
    const exp = typeof b?.expires_at === 'string' ? new Date(b.expires_at) : null;
    if (typeof b?.token !== 'string' || !b.token || !exp || Number.isNaN(exp.getTime()))
      throw new GitHubAppError('invalid_token_response');
    return { token: b.token, expiresAt: exp };
  }

  /**
   * User-to-server check for the install callback: exchanges the one-time `code` and confirms the installing user
   * can access the installation. The user token is used once here and discarded (never stored or returned).
   */
  async userCanAccessInstallation(code: unknown, installationId: string): Promise<boolean> {
    if (typeof code !== 'string' || !CODE_RE.test(code)) throw new GitHubAppError('invalid_code');
    if (!ID_RE.test(installationId)) throw new GitHubAppError('invalid_installation_id');
    const t = (await this.call(OAUTH_TOKEN_URL, 'POST', undefined, {
      client_id: this.opts.clientId,
      client_secret: await this.opts.clientSecret(),
      code,
    })) as { access_token?: unknown; error?: unknown };
    if (typeof t?.access_token !== 'string' || !t.access_token)
      throw new GitHubAppError('code_exchange_failed');
    const userToken = t.access_token;
    for (let page = 1; page <= 5; page++) {
      const b = (await this.call(
        `${API}/user/installations?per_page=100&page=${page}`,
        'GET',
        `Bearer ${userToken}`,
      )) as {
        installations?: { id?: unknown }[];
      };
      const list = Array.isArray(b?.installations) ? b.installations : [];
      if (list.some((i) => String(i?.id) === installationId)) return true;
      if (list.length < 100) return false;
    }
    return false;
  }

  /** No retries (codes are single-use; token mints are cheap to redo by the caller), no redirects, timeout. */
  private async call(
    url: string,
    method: string,
    authorization?: string,
    json?: Record<string, string>,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meetops',
    };
    if (authorization) headers.Authorization = authorization;
    if (json) headers['Content-Type'] = 'application/json';
    return fetchJson(
      this.fetchFn,
      url,
      { method, headers, ...(json ? { body: JSON.stringify(json) } : {}) },
      this.opts.timeoutMs,
      (code, status) => new GitHubAppError(code, status),
    );
  }
}

async function fetchJson(
  fetchFn: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number | undefined,
  err: (code: string, status?: number) => Error,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 10_000);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { ...init, redirect: 'error', signal: controller.signal });
  } catch (e) {
    throw err((e as { name?: string }).name === 'AbortError' ? 'timeout' : 'network_error');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  if (text.length > 1024 * 1024) throw err('response_too_large', res.status);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw err('invalid_json', res.status);
  }
  if (!res.ok) throw err('http_error', res.status);
  return body;
}

/** HTTP error shaped like Octokit's RequestError (status + response.headers) so classifyOctokitError applies. */
export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly response: { headers: Record<string, string> },
  ) {
    super(`GitHub API request failed (${status})`);
    this.name = 'GitHubHttpError';
  }
}

/** fetch-backed GitHubIssuesClient for GitHubIssuesProvider's clientFactory (no Octokit at runtime). */
export function createFetchGitHubIssuesClient(
  token: string,
  opts: { fetch?: FetchLike; timeoutMs?: number } = {},
): GitHubIssuesClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const seg = (s: string) => {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(s)) throw new GitHubHttpError(400, { headers: {} });
    return encodeURIComponent(s);
  };
  const req = async <T>(method: string, path: string, body?: unknown): Promise<{ data: T }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'meetops',
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      res = await fetchFn(`${API}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const h: Record<string, string> = {};
      for (const k of ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
        const v = res.headers?.get(k);
        if (v != null) h[k] = v;
      }
      throw new GitHubHttpError(res.status, { headers: h });
    }
    return { data: (text ? JSON.parse(text) : {}) as T };
  };
  return {
    rest: {
      issues: {
        create: async ({ owner, repo, ...body }) =>
          req<GitHubIssueData>('POST', `/repos/${seg(owner)}/${seg(repo)}/issues`, body),
        get: async ({ owner, repo, issue_number }) =>
          req<GitHubIssueData>(
            'GET',
            `/repos/${seg(owner)}/${seg(repo)}/issues/${Number(issue_number)}`,
          ),
        update: async ({ owner, repo, issue_number, ...body }) =>
          req<GitHubIssueData>(
            'PATCH',
            `/repos/${seg(owner)}/${seg(repo)}/issues/${Number(issue_number)}`,
            body,
          ),
      },
      repos: {
        get: async ({ owner, repo }) =>
          req<{ full_name: string }>('GET', `/repos/${seg(owner)}/${seg(repo)}`),
      },
    },
  };
}
