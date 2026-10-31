/**
 * Real GitHub end-to-end test for the GitHub App integration path (opt-in; skipped in CI without secrets).
 *
 * Enable with:
 *   MEETOPS_GITHUB_E2E=1
 *   GITHUB_APP_ID=<numeric app id>
 *   GITHUB_APP_PRIVATE_KEY_FILE=<path to PEM>   (preferred; inline GITHUB_APP_PRIVATE_KEY=<PEM> is a fallback)
 * Installation stage (also needs the App installed on a throwaway repo with Issues enabled):
 *   GITHUB_E2E_INSTALLATION_ID=<installation id>
 *   GITHUB_E2E_REPO=<owner/repo>   (name must contain e2e/throwaway, or be in GITHUB_E2E_REPO_ALLOWLIST)
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
/** Prefers GITHUB_APP_PRIVATE_KEY_FILE; the inline GITHUB_APP_PRIVATE_KEY is only a fallback. */
function loadKey(): string {
  const file = env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (file) return String(readFileSync(file, 'utf8'));
  return env.GITHUB_APP_PRIVATE_KEY ?? '';
}
const appEnabled =
  env.MEETOPS_GITHUB_E2E === '1' &&
  /^\d+$/.test(appId) &&
  Boolean(env.GITHUB_APP_PRIVATE_KEY_FILE || env.GITHUB_APP_PRIVATE_KEY);
const installationId = env.GITHUB_E2E_INSTALLATION_ID ?? '';
const repo = env.GITHUB_E2E_REPO ?? '';
const installConfigured =
  appEnabled && /^\d+$/.test(installationId) && /^[\w.-]+\/[\w.-]+$/.test(repo);
/** Writes only go to a throwaway repo: name contains e2e/throwaway, or listed in GITHUB_E2E_REPO_ALLOWLIST. */
const repoAllowlist = (env.GITHUB_E2E_REPO_ALLOWLIST ?? '')
  .split(',')
  .map((r) => r.trim().toLowerCase())
  .filter(Boolean);
const repoIsThrowaway =
  /e2e|throwaway/i.test(repo.split('/')[1] ?? '') || repoAllowlist.includes(repo.toLowerCase());
const installEnabled = installConfigured && repoIsThrowaway;

const API = 'https://api.github.com';
const ghHeaders = (bearer: string) => ({
  Authorization: `Bearer ${bearer}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'meetops-e2e',
});

describe.skipIf(!appEnabled)('GitHub App e2e (real api.github.com)', () => {
  it('App JWT authenticates as the App', async () => {
    const jwt: string = createGitHubAppJwt(appId, loadKey());
    const res = await fetch(`${API}/app`, { headers: ghHeaders(jwt) });
    expect(res.status).toBe(200);
    const app = (await res.json()) as { id?: number; permissions?: Record<string, string> };
    expect(String(app.id)).toBe(appId);
    expect(app.permissions?.issues).toBe('write');
  });

  it.skipIf(!installConfigured || repoIsThrowaway)('refuses a non-throwaway GITHUB_E2E_REPO', () => {
    throw new Error(
      `Refusing to create issues in "${repo}": GITHUB_E2E_REPO must be a throwaway repo (name contains ` +
        '"e2e" or "throwaway") or be listed in GITHUB_E2E_REPO_ALLOWLIST (comma-separated owner/repo).',
    );
  });

  describe.skipIf(!installEnabled)(
    'installation -> token -> issues via GitHubIssuesProvider',
    () => {
      const makeClient = () =>
        new GitHubAppClient({
          appId,
          privateKey: async () => loadKey(),
          clientId: env.GITHUB_APP_CLIENT_ID || 'unused-in-e2e',
          clientSecret: async () => '',
        });
      let token: string | undefined;
      let issueKey: string | undefined;
      /** Issue number from the raw create response, so cleanup works even if parsing/read-back fails. */
      let rawIssueNumber: number | undefined;
      let provider: GitHubIssuesProvider | undefined;
      const g = governance(true);

      afterAll(async () => {
        // Cleanup: close the issue (not_planned) then revoke the installation token. Best effort, no secret output.
        let closed = false;
        if (provider && issueKey) {
          const payload = { key: issueKey, status: 'closed' as const };
          closed = await provider
            .updateStatus(issueKey, 'closed', approvalFor('github', 'updateStatus', payload))
            .then(() => true)
            .catch(() => false);
        }
        if (!closed && token && rawIssueNumber) {
          // Fallback: direct PATCH using the number from the raw create response.
          await fetch(`${API}/repos/${repo}/issues/${rawIssueNumber}`, {
            method: 'PATCH',
            headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
          }).catch(() => undefined);
        }
        if (token) {
          await fetch(`${API}/installation/token`, {
            method: 'DELETE',
            headers: ghHeaders(token),
          }).catch(() => undefined);
        }
      });

      it('confirms the installation belongs to the App and mints an installation token', async () => {
        const client = makeClient();
        const inst = await client.getInstallation(installationId);
        expect(inst.id).toBe(installationId);
        expect(repo.toLowerCase().startsWith(`${inst.accountLogin.toLowerCase()}/`)).toBe(true);
        const minted = await client.createInstallationToken(installationId);
        token = minted.token; // stored before any assertion so cleanup always revokes it
        expect(typeof minted.token === 'string' && minted.token.length > 0).toBe(true);
        expect(minted.expiresAt.getTime()).toBeGreaterThan(Date.now());
      });

      it('health-checks, creates, reads and transitions a real issue through the integration path', async () => {
        expect(token).toBeDefined();
        provider = new GitHubIssuesProvider({
          organizationId: ORG,
          integrationId: INTEGRATION,
          credentials: {
            resolve: async () => ({ kind: 'github' as const, token: token as string }),
          },
          approvals: g.approvals,
          audit: g.audit,
          defaultRepo: repo,
          clientFactory: (t) => {
            const c = createFetchGitHubIssuesClient(t);
            const create = c.rest.issues.create;
            c.rest.issues.create = async (params) => {
              const res = await create(params);
              const n = (res.data as { number?: unknown } | undefined)?.number;
              if (typeof n === 'number' && Number.isInteger(n) && n > 0) rawIssueNumber = n;
              return res;
            };
            return c;
          },
          retry: { maxAttempts: 2 },
        });
        expect(await provider.healthCheck()).toMatchObject({ ok: true, provider: 'github' });

        const input = {
          title: `meetops e2e ${new Date().toISOString()}`,
          description: 'Automated MeetOps GitHub App e2e test issue; closed automatically.',
          externalRef: `e2e_${Date.now()}`,
        };
        const created = await provider.createIssue(
          input,
          approvalFor('github', 'createIssue', input),
        );
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
    },
  );
});
