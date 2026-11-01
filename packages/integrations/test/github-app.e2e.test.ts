/**
 * Real GitHub end-to-end test for the GitHub App integration path (opt-in; skipped in CI without secrets).
 *
 * Enable with:
 *   MEETOPS_GITHUB_E2E=1
 *   GITHUB_APP_ID=<numeric app id>
 *   GITHUB_APP_PRIVATE_KEY_FILE=<path to PEM>
 *   (inline GITHUB_APP_PRIVATE_KEY=<PEM> is used instead only with MEETOPS_GITHUB_E2E_USE_ENV_KEY=1)
 * Installation stage (also needs the App installed on a throwaway repo with Issues enabled):
 *   GITHUB_E2E_INSTALLATION_ID=<installation id>
 *   GITHUB_E2E_REPO=<owner/repo>   (name must start or end with an e2e/throwaway segment, or be in GITHUB_E2E_REPO_ALLOWLIST)
 *
 * Never logs or asserts on token/key values (assertion diffs would print them). Cleanup closes the created issue
 * as not_planned (GitHub REST cannot delete issues) and revokes the installation token.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createFetchGitHubIssuesClient,
  createGitHubAppJwt,
  GitHubAppClient,
  GitHubIssuesProvider,
} from '../src';
import { isThrowawayRepo, selectKeySource } from './e2e-guard';
import { approvalFor, governance, INTEGRATION, ORG } from './helpers';

const env = process.env;
const appId = env.GITHUB_APP_ID ?? '';
const keySource: { kind: 'file'; path: string } | { kind: 'env' } | null = selectKeySource(env);
/** Key file only, unless MEETOPS_GITHUB_E2E_USE_ENV_KEY=1 opts into the inline GITHUB_APP_PRIVATE_KEY. */
function loadKey(): string {
  if (keySource?.kind === 'file') return String(readFileSync(keySource.path, 'utf8'));
  if (keySource?.kind === 'env') return env.GITHUB_APP_PRIVATE_KEY ?? '';
  return '';
}
const appEnabled = env.MEETOPS_GITHUB_E2E === '1' && /^\d+$/.test(appId) && keySource !== null;
const installationId = env.GITHUB_E2E_INSTALLATION_ID ?? '';
const repo = env.GITHUB_E2E_REPO ?? '';
const installConfigured =
  appEnabled && /^\d+$/.test(installationId) && /^[\w.-]+\/[\w.-]+$/.test(repo);
/** Writes only go to a throwaway repo (see isThrowawayRepo) or one listed in GITHUB_E2E_REPO_ALLOWLIST. */
const repoIsThrowaway = isThrowawayRepo(repo, env.GITHUB_E2E_REPO_ALLOWLIST ?? '');
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

  it.skipIf(!installConfigured || repoIsThrowaway)(
    'refuses a non-throwaway GITHUB_E2E_REPO',
    () => {
      throw new Error(
        `Refusing to create issues in "${repo}": GITHUB_E2E_REPO must be a throwaway repo (name starts or ` +
          'ends with an "e2e"/"throwaway" segment, e.g. e2e-foo, foo-e2e) or be listed in GITHUB_E2E_REPO_ALLOWLIST (comma-separated owner/repo).',
      );
    },
  );

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
      /** Set only after GET /installation/repositories confirmed GITHUB_E2E_REPO is granted (L-1). */
      let repoGranted = false;
      /** Unique title marker of the issue we tried to create, to find it if create threw after GitHub created it. */
      let titleMarker: string | undefined;
      let orphanHandled = false;
      const g = governance(true);

      const closeByNumber = async (n: number) => {
        if (!token) return;
        await fetch(`${API}/repos/${repo}/issues/${n}`, {
          method: 'PATCH',
          headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
        }).catch(() => undefined);
      };
      /** Open issues (not PRs) in the repo whose title carries the marker, newest first, first 3 pages. */
      const findByMarker = async (marker: string): Promise<number[]> => {
        if (!token) return [];
        const found: number[] = [];
        for (let page = 1; page <= 3; page++) {
          const res = await fetch(
            `${API}/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100&page=${page}`,
            { headers: ghHeaders(token) },
          ).catch(() => undefined);
          if (!res?.ok) break;
          const list = (await res.json().catch(() => [])) as {
            number?: unknown;
            title?: unknown;
            pull_request?: unknown;
          }[];
          for (const i of list)
            if (
              !i.pull_request &&
              typeof i.number === 'number' &&
              typeof i.title === 'string' &&
              i.title.includes(marker)
            )
              found.push(i.number);
          if (list.length < 100) break;
        }
        return found;
      };
      /** Closes an issue left behind by a create that threw: raw response number first, else the title marker. */
      const closeOrphan = async () => {
        if (orphanHandled || issueKey) return;
        orphanHandled = true;
        if (rawIssueNumber) return closeByNumber(rawIssueNumber);
        if (titleMarker) for (const n of await findByMarker(titleMarker)) await closeByNumber(n);
      };

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
          await closeByNumber(rawIssueNumber);
        } else if (!closed && token && !issueKey) {
          await closeOrphan().catch(() => undefined);
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
        // The installation must actually be granted GITHUB_E2E_REPO, not just belong to its owner.
        // Paginate to the end (I-1); hitting the safety cap fails explicitly instead of silently stopping.
        const MAX_PAGES = 100;
        const names: string[] = [];
        let done = false;
        for (let page = 1; page <= MAX_PAGES && !done; page++) {
          const res = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
            headers: ghHeaders(token ?? ''),
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as { repositories?: { full_name?: string }[] };
          const list = body.repositories ?? [];
          names.push(...list.map((x) => String(x.full_name).toLowerCase()));
          done = list.length < 100;
        }
        if (!done)
          throw new Error(
            `Installation grants more than ${MAX_PAGES * 100} repositories; refusing to guess whether GITHUB_E2E_REPO is granted.`,
          );
        expect(names).toContain(repo.toLowerCase());
        repoGranted = true;
      });

      it('health-checks, creates, reads and transitions a real issue through the integration path', async () => {
        // L-1: never write unless the previous test proved the installation is granted this exact repo.
        if (!repoGranted || !token)
          throw new Error(
            'Refusing to create an issue: GITHUB_E2E_REPO was not confirmed in the installation repositories.',
          );
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

        titleMarker = `[meetops-e2e:${randomUUID()}]`;
        const input = {
          title: `meetops e2e ${new Date().toISOString()} ${titleMarker}`,
          description: 'Automated MeetOps GitHub App e2e test issue; closed automatically.',
          externalRef: `e2e_${Date.now()}`,
        };
        let created: Awaited<ReturnType<GitHubIssuesProvider['createIssue']>>;
        try {
          created = await provider.createIssue(input, approvalFor('github', 'createIssue', input));
        } catch (err) {
          // GitHub may have created the issue before the throw (e.g. response parsing): close it now.
          await closeOrphan().catch(() => undefined);
          throw err;
        }
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
