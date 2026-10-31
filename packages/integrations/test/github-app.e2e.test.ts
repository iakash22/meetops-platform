/**
 * Real GitHub end-to-end test for the GitHub App integration path (opt-in; skipped in CI without secrets).
 *
 * Enable with:
 *   MEETOPS_GITHUB_E2E=1
 *   GITHUB_APP_ID=<numeric app id>
 *   GITHUB_APP_PRIVATE_KEY_FILE=<path to PEM>   (or GITHUB_APP_PRIVATE_KEY=<PEM>)
 * Installation stage (also needs the App installed on a throwaway repo with Issues enabled):
 *   GITHUB_E2E_INSTALLATION_ID=<installation id>
 *   GITHUB_E2E_REPO=<owner/repo>
 *
 * Never logs or asserts on token/key values (assertion diffs would print them). Cleanup closes the created issue
 * as not_planned (GitHub REST cannot delete issues) and revokes the installation token.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createFetchGitHubIssuesClient,
  createGitHubAppJwt,
  GitHubAppClient,
  GitHubIssuesProvider,
} from '../src';
import { approvalFor, governance, INTEGRATION, ORG } from './helpers';

const env = process.env;
const appId = env.GITHUB_APP_ID ?? '';
const loadKey = (): string =>
  env.GITHUB_APP_PRIVATE_KEY_FILE
    ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8')
    : (env.GITHUB_APP_PRIVATE_KEY ?? '');
const appEnabled =
  env.MEETOPS_GITHUB_E2E === '1' &&
  /^\d+$/.test(appId) &&
  Boolean(env.GITHUB_APP_PRIVATE_KEY_FILE || env.GITHUB_APP_PRIVATE_KEY);
const installationId = env.GITHUB_E2E_INSTALLATION_ID ?? '';
const repo = env.GITHUB_E2E_REPO ?? '';
const installEnabled = appEnabled && /^\d+$/.test(installationId) && /^[\w.-]+\/[\w.-]+$/.test(repo);

const API = 'https://api.github.com';
const ghHeaders = (bearer: string) => ({
  Authorization: `Bearer ${bearer}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'meetops-e2e',
});

describe.skipIf(!appEnabled)('GitHub App e2e (real api.github.com)', () => {
  it('App JWT authenticates as the App', async () => {
    const res = await fetch(`${API}/app`, { headers: ghHeaders(createGitHubAppJwt(appId, loadKey())) });
    expect(res.status).toBe(200);
    const app = (await res.json()) as { id?: number; permissions?: Record<string, string> };
    expect(String(app.id)).toBe(appId);
    expect(app.permissions?.issues).toBe('write');
  });

  describe.skipIf(!installEnabled)('installation -> token -> issues via GitHubIssuesProvider', () => {
    const client = new GitHubAppClient({
      appId,
      privateKey: async () => loadKey(),
      clientId: env.GITHUB_APP_CLIENT_ID || 'unused-in-e2e',
      clientSecret: async () => '',
    });
    let token: string | undefined;
    let issueKey: string | undefined;
    let provider: GitHubIssuesProvider | undefined;
    const g = governance(true);

    afterAll(async () => {
      // Cleanup: close the issue (not_planned) then revoke the installation token. Best effort, no secret output.
      if (provider && issueKey) {
        const payload = { key: issueKey, status: 'closed' as const };
        await provider
          .updateStatus(issueKey, 'closed', approvalFor('github', 'updateStatus', payload))
          .catch(() => undefined);
      }
      if (token) {
        await fetch(`${API}/installation/token`, { method: 'DELETE', headers: ghHeaders(token) }).catch(
          () => undefined,
        );
      }
    });

    it('confirms the installation belongs to the App and mints an installation token', async () => {
      const inst = await client.getInstallation(installationId);
      expect(inst.id).toBe(installationId);
      expect(repo.toLowerCase().startsWith(`${inst.accountLogin.toLowerCase()}/`)).toBe(true);
      const minted = await client.createInstallationToken(installationId);
      expect(typeof minted.token === 'string' && minted.token.length > 0).toBe(true);
      expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());
      token = minted.token;
    });

    it('health-checks, creates, reads and transitions a real issue through the integration path', async () => {
      expect(token).toBeDefined();
      provider = new GitHubIssuesProvider({
        organizationId: ORG,
        integrationId: INTEGRATION,
        credentials: { resolve: async () => ({ kind: 'github' as const, token: token as string }) },
        approvals: g.approvals,
        audit: g.audit,
        defaultRepo: repo,
        clientFactory: (t) => createFetchGitHubIssuesClient(t),
        retry: { maxAttempts: 2 },
      });
      expect(await provider.healthCheck()).toMatchObject({ ok: true, provider: 'github' });

      const input = {
        title: `meetops e2e ${new Date().toISOString()}`,
        description: 'Automated MeetOps GitHub App e2e test issue; closed automatically.',
        externalRef: `e2e_${Date.now()}`,
      };
      const created = await provider.createIssue(input, approvalFor('github', 'createIssue', input));
      issueKey = created.key;
      expect(created).toMatchObject({ provider: 'github', status: 'open' });
      expect(created.key.toLowerCase().startsWith(`${repo.toLowerCase()}#`)).toBe(true);

      const fetched = await provider.getIssue(created.key);
      expect(fetched).toMatchObject({ key: created.key, title: input.title, status: 'open' });

      const done = await provider.updateStatus(
        created.key,
        'done',
        approvalFor('github', 'updateStatus', { key: created.key, status: 'done' }),
      );
      expect(done.status).toBe('done');
      expect(g.events.filter((e) => e.phase === 'success')).toHaveLength(2);
    });
  });
});
