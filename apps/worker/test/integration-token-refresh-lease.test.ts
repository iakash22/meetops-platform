import { describe, it, expect, vi } from 'vitest';
import type { IntegrationConnectionRecord, IntegrationSecrets } from '@meetops/database';
import {
  createRedisConnectionLease,
  RELEASE_LEASE_LUA,
  runTokenRefreshSweep,
  TOKEN_REFRESH_LEASE_TTL_MS,
  tokenRefreshLeaseKey,
  type LeaseRedis,
  type TokenRefreshRepository,
} from '../src/integrations/index.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const NOW = Date.parse('2026-11-01T10:00:00Z');
const KEY = tokenRefreshLeaseKey(ORG, 'j1');

/** In-memory Redis with SET NX PX semantics on a manual clock, and EVAL of the release script only. */
function fakeRedis() {
  let clock = 0;
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.expiresAt <= clock) store.delete(k);
    return store.get(k);
  };
  const set = vi.fn(async (k: string, v: string, _px: 'PX', ttl: number) => {
    if (live(k)) return null;
    store.set(k, { value: v, expiresAt: clock + ttl });
    return 'OK' as const;
  });
  const redis: LeaseRedis & {
    advance(ms: number): void;
    peek(k: string): string | undefined;
    setSpy: typeof set;
  } = {
    set,
    setSpy: set,
    eval: vi.fn(async (script: string, _n: number, k: string, token: string) => {
      if (script !== RELEASE_LEASE_LUA) throw new Error('unexpected script');
      if (live(k)?.value !== token) return 0;
      store.delete(k);
      return 1;
    }),
    advance: (ms) => void (clock += ms),
    peek: (k) => live(k)?.value,
  };
  return redis;
}

/** One Jira connection whose upsert really rotates the stored tokens and expiry. */
function jiraRepo() {
  const r: IntegrationConnectionRecord & { secrets: IntegrationSecrets } = {
    id: 'j1',
    organizationId: ORG,
    provider: 'jira',
    status: 'active',
    displayName: 'acme',
    externalAccountId: 'cloud-1',
    connectedById: null,
    tokenKeyId: 'k1',
    accessTokenExpiresAt: new Date(NOW + 60_000),
    revokedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    secrets: { accessToken: 'a0', refreshToken: 'r0', webhookSecret: 'whs' },
  };
  const setStatus = vi.fn<TokenRefreshRepository['setStatus']>(async () => null);
  const repo: TokenRefreshRepository = {
    listDueForRefresh: async () => [{ organizationId: ORG, id: 'j1', provider: 'jira' }],
    get: async () => ({ ...r }),
    readSecrets: async () => ({ ...r.secrets }),
    upsert: async (_o, input) => {
      r.secrets = {
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        webhookSecret: r.secrets.webhookSecret,
      };
      r.accessTokenExpiresAt = input.accessTokenExpiresAt ?? null;
      return { ...r };
    },
    setStatus,
  };
  return { repo, row: r, setStatus };
}

const log = () => ({ info: vi.fn(), warn: vi.fn() });
let n = 0;
const rotated = () => ({ accessToken: `a${++n}`, refreshToken: `r${n}`, expiresAt: NOW + 3600e3 });

describe('token refresh per-connection lease', () => {
  it('two concurrent refreshes of one connection make exactly one provider call', async () => {
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const { repo, row } = jiraRepo();
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const jira = {
      refresh: vi.fn(async () => {
        await gate; // hold the first refresh in flight while the second sweep runs
        return rotated();
      }),
    };
    const deps = { repo, providers: { jira }, log: log(), lease, now: () => NOW };
    const a = runTokenRefreshSweep(deps);
    await vi.waitFor(() => expect(jira.refresh).toHaveBeenCalledTimes(1));
    const b = await runTokenRefreshSweep(deps);
    expect(b).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    finish();
    expect(await a).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(jira.refresh).toHaveBeenCalledTimes(1);
    expect(jira.refresh).toHaveBeenCalledWith('r0');
    expect(row.secrets.refreshToken).toMatch(/^r\d+$/);
    expect(redis.peek(KEY)).toBeUndefined(); // released

    // A sweep whose due list was read before that refresh finished (stale list) gets the lease afterwards, reads
    // the new expiry under it and skips instead of rotating the token again.
    expect(await runTokenRefreshSweep(deps)).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    expect(jira.refresh).toHaveBeenCalledTimes(1);

    // Started together with Promise.all: still exactly one provider call.
    const { repo: repo2 } = jiraRepo();
    const jira2 = { refresh: vi.fn(async () => rotated()) };
    const deps2 = { repo: repo2, providers: { jira: jira2 }, log: log(), lease, now: () => NOW };
    const rs = await Promise.all([runTokenRefreshSweep(deps2), runTokenRefreshSweep(deps2)]);
    expect(jira2.refresh).toHaveBeenCalledTimes(1);
    expect(rs.map((r) => r.refreshed).sort()).toEqual([0, 1]);
    expect(rs.map((r) => r.failed)).toEqual([0, 0]);
  });

  it('a lease left by a crashed holder blocks until it expires, then the refresh runs', async () => {
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const { repo } = jiraRepo();
    const jira = { refresh: vi.fn(async () => rotated()) };
    const deps = { repo, providers: { jira }, log: log(), lease, now: () => NOW };
    expect(await lease.acquire(KEY, TOKEN_REFRESH_LEASE_TTL_MS)).toEqual(expect.any(String)); // never released

    expect(await runTokenRefreshSweep(deps)).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    redis.advance(TOKEN_REFRESH_LEASE_TTL_MS - 1);
    expect(await runTokenRefreshSweep(deps)).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    expect(jira.refresh).not.toHaveBeenCalled();

    redis.advance(1);
    expect(await runTokenRefreshSweep(deps)).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(jira.refresh).toHaveBeenCalledTimes(1);
    expect(redis.setSpy).toHaveBeenLastCalledWith(
      KEY,
      expect.any(String),
      'PX',
      TOKEN_REFRESH_LEASE_TTL_MS,
      'NX',
    );
  });

  it('releases the lease after a provider error (transient and permanent), so the next sweep retries', async () => {
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const { repo } = jiraRepo();
    const jira = {
      refresh: vi
        .fn<() => Promise<ReturnType<typeof rotated>>>()
        .mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 503 }))
        .mockResolvedValueOnce(rotated()),
    };
    const deps = { repo, providers: { jira }, log: log(), lease, now: () => NOW };
    expect(await runTokenRefreshSweep(deps)).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(redis.peek(KEY)).toBeUndefined();
    expect(await runTokenRefreshSweep(deps)).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(jira.refresh).toHaveBeenCalledTimes(2);

    const p = jiraRepo();
    const bad = {
      refresh: vi.fn(async () =>
        Promise.reject(Object.assign(new Error('x'), { code: 'invalid_grant' })),
      ),
    };
    await runTokenRefreshSweep({
      repo: p.repo,
      providers: { jira: bad },
      log: log(),
      lease,
      now: () => NOW,
    });
    expect(p.setStatus).toHaveBeenCalledWith(ORG, 'j1', 'error');
    expect(redis.peek(KEY)).toBeUndefined();
  });

  it('release is token-checked: an expired holder cannot delete the next holder lease', async () => {
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const first = await lease.acquire(KEY, 1000);
    expect(await lease.acquire(KEY, 1000)).toBeNull();
    redis.advance(1000);
    const second = await lease.acquire(KEY, 1000);
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
    expect(await lease.release(KEY, first!)).toBe(false);
    expect(redis.peek(KEY)).toBe(second);
    expect(await lease.release(KEY, second!)).toBe(true);
    expect(redis.peek(KEY)).toBeUndefined();
    // The script compares before deleting, atomically in Redis.
    expect(RELEASE_LEASE_LUA).toMatch(/redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\]/);
    expect(RELEASE_LEASE_LUA).toMatch(/redis\.call\('DEL', KEYS\[1\]\)/);
  });

  it('fails closed when Redis is unavailable: no refresh, counted as failed, no secrets logged', async () => {
    const { repo } = jiraRepo();
    const jira = { refresh: vi.fn(async () => rotated()) };
    const l = log();
    const lease = {
      acquire: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
      release: vi.fn(),
    };
    expect(
      await runTokenRefreshSweep({ repo, providers: { jira }, log: l, lease, now: () => NOW }),
    ).toEqual({
      refreshed: 0,
      failed: 1,
      skipped: 0,
    });
    expect(jira.refresh).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
    expect(JSON.stringify(l.warn.mock.calls)).not.toMatch(/r0|a0|whs/);
  });
});
