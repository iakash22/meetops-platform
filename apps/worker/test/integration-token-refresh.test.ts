import { describe, it, expect, vi } from 'vitest';
import type { IntegrationConnectionRecord, IntegrationSecrets } from '@meetops/database';
import { runTokenRefreshSweep, type TokenRefreshRepository } from '../src/integrations/index.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const NOW = Date.parse('2026-10-27T10:00:00Z');

function makeRepo(rows: (IntegrationConnectionRecord & { secrets: IntegrationSecrets })[]) {
  const upserts: {
    org: string;
    id: string;
    input: Parameters<TokenRefreshRepository['saveRefreshedTokens']>[2];
    fence: string;
  }[] = [];
  const statuses: [string, string][] = [];
  const list = vi.fn<TokenRefreshRepository['listDueForRefresh']>(async () =>
    rows.map((r) => ({ organizationId: r.organizationId, id: r.id, provider: r.provider })),
  );
  const repo: TokenRefreshRepository = {
    listDueForRefresh: list,
    readForRefresh: async (_o, id) => {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      const { secrets, ...connection } = r;
      return { connection, secrets, fence: `fence-${id}` };
    },
    saveRefreshedTokens: async (org, id, input, fence) => {
      upserts.push({ org, id, input, fence });
      return 'saved';
    },
    setStatus: async (_o, id, s) => {
      statuses.push([id, s]);
      return null;
    },
  };
  return { repo, list, upserts, statuses };
}
const row = (id: string, provider: string, extra: Partial<IntegrationConnectionRecord> = {}) => ({
  id,
  organizationId: ORG,
  provider,
  status: 'active' as const,
  displayName: 'acme',
  externalAccountId: provider === 'github' ? '99' : 'cloud-1',
  connectedById: null,
  tokenKeyId: 'k1',
  accessTokenExpiresAt: new Date(NOW + 60_000),
  revokedAt: null,
  createdAt: new Date(NOW),
  updatedAt: new Date(NOW),
  secrets: {
    accessToken: 'old-access',
    refreshToken: provider === 'jira' ? 'old-refresh' : null,
    webhookSecret: 'whs',
  },
  ...extra,
});
const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe('integration token refresh sweep', () => {
  it('rotates Jira tokens and mints GitHub installation tokens, keeping the webhook secret', async () => {
    const { repo, list, upserts } = makeRepo([row('j1', 'jira'), row('g1', 'github')]);
    const jira = {
      refresh: vi.fn(async () => ({
        accessToken: 'new-a',
        refreshToken: 'new-r',
        expiresAt: NOW + 3600e3,
      })),
    };
    const github = {
      createInstallationToken: vi.fn(async () => ({
        token: 'ghs_new',
        expiresAt: new Date(NOW + 3600e3),
      })),
    };
    const l = log();
    const r = await runTokenRefreshSweep({
      repo,
      providers: { jira, github },
      log: l,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 2, failed: 0, skipped: 0 });
    expect(list).toHaveBeenCalledWith(new Date(NOW + 600_000), 100);
    expect(jira.refresh).toHaveBeenCalledWith('old-refresh', { signal: expect.any(AbortSignal) });
    expect(github.createInstallationToken).toHaveBeenCalledWith('99', {
      signal: expect.any(AbortSignal),
    });
    expect(upserts[0]).toMatchObject({ org: ORG, id: 'j1', fence: 'fence-j1' });
    expect(upserts[0]!.input).toEqual({
      accessToken: 'new-a',
      refreshToken: 'new-r',
      webhookSecret: 'whs',
      accessTokenExpiresAt: new Date(NOW + 3600e3),
    });
    expect(upserts[1]).toMatchObject({ id: 'g1', fence: 'fence-g1' });
    expect(upserts[1]!.input).toMatchObject({
      accessToken: 'ghs_new',
      refreshToken: null,
      webhookSecret: 'whs',
    });
    expect(JSON.stringify([l.info.mock.calls, l.warn.mock.calls])).not.toMatch(
      /new-a|new-r|ghs_new|old-/,
    );
  });

  it('marks permanent failures as error, leaves transient ones for the next sweep, never logs secrets', async () => {
    const { repo, statuses } = makeRepo([row('j1', 'jira'), row('j2', 'jira')]);
    const jira = {
      refresh: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('old-refresh rejected'), { code: 'invalid_grant', status: 400 }),
        )
        .mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 503 })),
    };
    const l = log();
    const r = await runTokenRefreshSweep({ repo, providers: { jira }, log: l, now: () => NOW });
    expect(r).toEqual({ refreshed: 0, failed: 2, skipped: 0 });
    expect(statuses).toEqual([['j1', 'error']]);
    expect(JSON.stringify(l.warn.mock.calls)).not.toMatch(/old-refresh/);
  });

  it('skips unconfigured providers, inactive rows and missing secrets', async () => {
    const { repo, upserts } = makeRepo([
      row('j1', 'jira'),
      row('g1', 'github', { status: 'error' }),
      row('x', 'gitlab'),
    ]);
    const r = await runTokenRefreshSweep({ repo, providers: {}, log: log(), now: () => NOW });
    expect(r).toEqual({ refreshed: 0, failed: 0, skipped: 3 });
    expect(upserts).toHaveLength(0);
  });
});
