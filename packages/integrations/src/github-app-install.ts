import { assertAllowedRedirect, OAuthStateManager, type OAuthStateStore } from './oauth-state.js';

export class GitHubAppInstallError extends Error {
  constructor(readonly code: 'invalid_installation_id' | 'invalid_setup_action') {
    super(`GitHub App installation rejected: ${code}`);
    this.name = 'GitHubAppInstallError';
  }
}

export interface GitHubAppInstallOptions {
  /** App slug, e.g. "meetops-dev". */
  appSlug: string;
  /** Exact "Setup URL" values configured on the GitHub App. */
  redirectUriAllowlist: readonly string[];
  stateStore: OAuthStateStore;
  stateTtlSeconds?: number;
  now?: () => number;
}

/**
 * GitHub App installation: `https://github.com/apps/<slug>/installations/new?state=…`; GitHub redirects to the Setup URL
 * with `installation_id`, `setup_action` and `state`. State is single-use and bound to org+user+redirect.
 * The returned installation_id is UNTRUSTED until the backend confirms it with the App JWT
 * (`GET /app/installations/{id}`) and, for user-to-server flows, that the user can access it.
 */
export class GitHubAppInstallFlow {
  private readonly state: OAuthStateManager;
  constructor(private readonly opts: GitHubAppInstallOptions) {
    if (!/^[a-z0-9-]{1,100}$/.test(opts.appSlug)) throw new Error('Invalid GitHub App slug');
    for (const r of opts.redirectUriAllowlist) assertAllowedRedirect(r, opts.redirectUriAllowlist);
    const so: { ttlSeconds?: number; now?: () => number } = { ttlSeconds: opts.stateTtlSeconds ?? 600 };
    if (opts.now) so.now = opts.now;
    this.state = new OAuthStateManager(opts.stateStore, so);
  }

  async begin(input: { organizationId: string; userId: string; redirectUri: string }): Promise<{ url: string; state: string }> {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    const state = await this.state.issue({ provider: 'github-app', ...input });
    return { url: `https://github.com/apps/${this.opts.appSlug}/installations/new?state=${state}`, state };
  }

  async complete(input: { state: unknown; installationId: unknown; setupAction: unknown; organizationId: string; userId: string; redirectUri: string }): Promise<{ installationId: string; setupAction: 'install' | 'update' }> {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    await this.state.consume(input.state, { provider: 'github-app', organizationId: input.organizationId, userId: input.userId, redirectUri: input.redirectUri });
    if (input.setupAction !== 'install' && input.setupAction !== 'update') throw new GitHubAppInstallError('invalid_setup_action');
    if (typeof input.installationId !== 'string' || !/^[1-9]\d{0,19}$/.test(input.installationId)) throw new GitHubAppInstallError('invalid_installation_id');
    return { installationId: input.installationId, setupAction: input.setupAction };
  }
}
