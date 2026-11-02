import { describe, it, expect, vi } from 'vitest';
import type { IntegrationConnectionRecord, IntegrationSecrets } from '@meetops/database';
import {
  CONFIRM_LEASE_LUA,
  createRedisConnectionLease,
  integrationsApiOrigin,
  IntegrationsApiOriginError,
  LEASE_REDIS_OPTIONS,
  RELEASE_LEASE_LUA,
  runTokenRefreshSweep,
  TokenRefreshEnvError,
  tokenRefreshLeaseKey,
  tokenRefreshProvidersFromEnv,
  watchLeaseRedis,
  type ConnectionLease,
  type LeaseRedis,
  type TokenRefreshRepository,
} from '../src/integrations/index.js';
import { calendarSyncProvidersFromEnv } from '../src/calendar/scheduler.js';
import { CalendarSyncEnvError } from '../src/calendar/sync.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const NOW = Date.parse('2026-11-02T08:00:00Z');
const KEY = tokenRefreshLeaseKey(ORG, 'j1');
const SECRETS = /a0|r0|whs|new-a|new-r|ghs_/;

/** In-memory Redis (SET NX PX, release + confirm scripts) on a manual clock. */
function fakeRedis() {
  let clock = 0;
  const store = new Map<string, { value: string; expiresAt: number }>();
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.expiresAt <= clock) store.delete(k);
    return store.get(k);
  };
  const redis: LeaseRedis & { advance(ms: number): void; peek(k: string): string | undefined } = {
    set: async (k, v, _px, ttl) => {
      if (live(k)) return null;
      store.set(k, { value: v, expiresAt: clock + ttl });
      return 'OK';
    },
    eval: async (script, _n, k, token, ttl) => {
      const e = live(k);
      if (e?.value !== token) return 0;
      if (script === CONFIRM_LEASE_LUA) {
        e.expiresAt = clock + Number(ttl);
        return 1;
      }
      if (script === RELEASE_LEASE_LUA) {
        store.delete(k);
        return 1;
      }
      throw new Error('unexpected script');
    },
    advance: (ms) => void (clock += ms),
    peek: (k) => live(k)?.value,
  };
  return redis;
}

/** One connection with a real write fence: every saved write bumps the version, a stale fence is superseded. */
function connRepo(provider: 'jira' | 'github' = 'jira') {
  const r: IntegrationConnectionRecord & { secrets: IntegrationSecrets } = {
    id: 'j1',
    organizationId: ORG,
    provider,
    status: 'active',
    displayName: 'acme',
    externalAccountId: provider === 'github' ? '99' : 'cloud-1',
    connectedById: null,
    tokenKeyId: 'k1',
    accessTokenExpiresAt: new Date(NOW + 60_000),
    revokedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    secrets: {
      accessToken: 'a0',
      refreshToken: provider === 'jira' ? 'r0' : null,
      webhookSecret: 'whs',
    },
  };
  let version = 0;
  const saveFailures = { left: 0 };
  const statusCalls: { status: string; fence?: string }[] = [];
  const save = vi.fn<TokenRefreshRepository['saveRefreshedTokens']>(async (_o, _id, t, fence) => {
    if (saveFailures.left > 0) {
      saveFailures.left--;
      throw Object.assign(new Error(`db down while saving ${t.accessToken}`), {
        name: 'PrismaClientKnownRequestError',
      });
    }
    if (r.status !== 'active' || fence !== `v${version}`) return 'superseded';
    version++;
    r.secrets = {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      webhookSecret: t.webhookSecret,
    };
    r.accessTokenExpiresAt = t.accessTokenExpiresAt;
    return 'saved';
  });
  const repo: TokenRefreshRepository = {
    listDueForRefresh: async () => [{ organizationId: ORG, id: 'j1', provider }],
    readForRefresh: async () => {
      const { secrets, ...connection } = r;
      return { connection: { ...connection }, secrets: { ...secrets }, fence: `v${version}` };
    },
    saveRefreshedTokens: save,
    setStatus: async (_o, _id, status, opts) => {
      statusCalls.push({ status, fence: opts?.fence });
      if (opts?.fence !== undefined && opts.fence !== `v${version}`) return null;
      r.status = status;
      version++;
      return { ...r };
    },
  };
  /** Another holder's refresh landing in between (what a newer success looks like to the fence). */
  const landNewerRefresh = (token: string) => {
    version++;
    r.secrets = { ...r.secrets, accessToken: token, refreshToken: `${token}-r` };
  };
  return { repo, row: r, save, saveFailures, statusCalls, landNewerRefresh };
}
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const logged = (l: ReturnType<typeof log>) =>
  JSON.stringify([l.info.mock.calls, l.warn.mock.calls]);
const never = <T>() => new Promise<T>(() => undefined);

describe('token refresh hardening: provider deadline (item 1)', () => {
  it('a provider that never answers (and ignores the signal) times out: transient, nothing saved, lease released', async () => {
    const redis = fakeRedis();
    const c = connRepo();
    let seen: AbortSignal | undefined;
    const jira = {
      refresh: vi.fn((_rt: string, opts?: { signal?: AbortSignal }) => {
        seen = opts?.signal;
        return never<{ accessToken: string; refreshToken: string; expiresAt: number }>();
      }),
    };
    const l = log();
    const started = Date.now();
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: l,
      lease: createRedisConnectionLease(redis),
      refreshTimeoutMs: 25,
      now: () => NOW,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(seen?.aborted).toBe(true);
    expect(c.save).not.toHaveBeenCalled();
    expect(c.statusCalls).toEqual([]); // a timeout is not a revoked grant
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errName: 'TokenRefreshTimeoutError', permanent: false }),
      'integration token refresh failed',
    );
    expect(redis.peek(KEY)).toBeUndefined();
  });

  it('the refresh deadline is capped below the lease TTL', async () => {
    const c = connRepo();
    const jira = { refresh: vi.fn(() => never<never>()) };
    const started = Date.now();
    await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: log(),
      leaseTtlMs: 60,
      refreshTimeoutMs: 600_000,
      now: () => NOW,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('token refresh hardening: lease validity + fence before saving (items 1, 4)', () => {
  it('a slow refresh that outlived its lease cannot overwrite a newer success', async () => {
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const c = connRepo();
    const l = log();
    const jira = {
      refresh: vi.fn(async () => {
        // While this call is slow, the TTL passes and another holder refreshes the connection.
        redis.advance(1_000);
        const other = await lease.acquire(KEY, 1_000);
        expect(other).not.toBeNull();
        c.landNewerRefresh('newer');
        return { accessToken: 'new-a', refreshToken: 'new-r', expiresAt: NOW + 3600e3 };
      }),
    };
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: l,
      lease,
      leaseTtlMs: 1_000,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    expect(c.row.secrets.accessToken).toBe('newer'); // the newer success survives
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: 'j1' }),
      'integration token refresh outlived its lease; saving under the fence',
    );
    expect(l.info).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: 'j1' }),
      'integration token refresh superseded by a newer write; not saved',
    );
    expect(logged(l)).not.toMatch(SECRETS);
  });

  it('a lease lost with no newer write still stores the rotated tokens (never dropped)', async () => {
    const redis = fakeRedis();
    const c = connRepo();
    const jira = {
      refresh: vi.fn(async () => {
        redis.advance(5_000); // lease expired, nobody else took it
        return { accessToken: 'new-a', refreshToken: 'new-r', expiresAt: NOW + 3600e3 };
      }),
    };
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: log(),
      lease: createRedisConnectionLease(redis),
      leaseTtlMs: 1_000,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(c.row.secrets).toMatchObject({ accessToken: 'new-a', refreshToken: 'new-r' });
  });

  it('confirms (and renews) the lease right before the write', async () => {
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const confirm = vi.spyOn(lease, 'confirm');
    const c = connRepo();
    const jira = {
      refresh: vi.fn(async () => {
        redis.advance(900); // close to the TTL, still held
        return { accessToken: 'new-a', refreshToken: 'new-r', expiresAt: NOW + 3600e3 };
      }),
    };
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: log(),
      lease,
      leaseTtlMs: 1_000,
      now: () => NOW,
    });
    expect(r.refreshed).toBe(1);
    expect(confirm).toHaveBeenCalledWith(KEY, expect.any(String), 1_000);
    expect(c.save.mock.invocationCallOrder[0]).toBeGreaterThan(
      confirm.mock.invocationCallOrder[0]!,
    );
  });

  it('a permanent error is only marked while the lease is held, and only under the fence', async () => {
    const bad = {
      refresh: vi.fn(async () =>
        Promise.reject(
          Object.assign(new Error('r0 rejected'), { code: 'invalid_grant', status: 400 }),
        ),
      ),
    };
    // Lease lost before the mark: no write at all.
    const redis = fakeRedis();
    const lease = createRedisConnectionLease(redis);
    const c = connRepo();
    const l = log();
    bad.refresh.mockImplementationOnce(async () => {
      redis.advance(5_000);
      await lease.acquire(KEY, 5_000); // the next holder
      throw Object.assign(new Error('r0 rejected'), { code: 'invalid_grant' });
    });
    await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira: bad },
      log: l,
      lease,
      leaseTtlMs: 1_000,
      now: () => NOW,
    });
    expect(c.statusCalls).toEqual([]);
    expect(c.row.status).toBe('active');
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'permanent' }),
      'integration token refresh lease lost; not marking error',
    );

    // Lease held but a newer refresh landed (the old token's rejection is stale): fenced, so not marked.
    const c2 = connRepo();
    bad.refresh.mockImplementationOnce(async () => {
      c2.landNewerRefresh('newer');
      throw Object.assign(new Error('x'), { code: 'invalid_grant' });
    });
    await runTokenRefreshSweep({
      repo: c2.repo,
      providers: { jira: bad },
      log: log(),
      lease: createRedisConnectionLease(fakeRedis()),
      now: () => NOW,
    });
    expect(c2.statusCalls).toEqual([{ status: 'error', fence: 'v0' }]);
    expect(c2.row.status).toBe('active');

    // Lease held and nothing changed: marked.
    const c3 = connRepo();
    await runTokenRefreshSweep({
      repo: c3.repo,
      providers: { jira: bad },
      log: log(),
      lease: createRedisConnectionLease(fakeRedis()),
      now: () => NOW,
    });
    expect(c3.row.status).toBe('error');
    expect(logged(l)).not.toMatch(SECRETS);
  });
});

describe('token refresh hardening: save retry, then needs-reauth (item 3)', () => {
  it('retries a failed save with backoff and stores the rotated tokens', async () => {
    const c = connRepo();
    c.saveFailures.left = 2;
    const sleep = vi.fn(async () => undefined);
    const jira = {
      refresh: vi.fn(async () => ({
        accessToken: 'new-a',
        refreshToken: 'new-r',
        expiresAt: NOW + 3600e3,
      })),
    };
    const l = log();
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: l,
      sleep,
      saveRetryDelayMs: 10,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(c.save).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(jira.refresh).toHaveBeenCalledTimes(1); // never re-rotates to recover from a DB error
    expect(c.row.secrets).toMatchObject({ accessToken: 'new-a', refreshToken: 'new-r' });
    expect(logged(l)).not.toMatch(SECRETS);
  });

  it('when the rotated Jira tokens still cannot be stored, marks the connection needs-reauth and says so', async () => {
    const c = connRepo();
    c.saveFailures.left = 99;
    const jira = {
      refresh: vi.fn(async () => ({
        accessToken: 'new-a',
        refreshToken: 'new-r',
        expiresAt: NOW + 3600e3,
      })),
    };
    const l = log();
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: l,
      lease: createRedisConnectionLease(fakeRedis()),
      sleep: async () => undefined,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(c.save).toHaveBeenCalledTimes(3);
    expect(c.statusCalls).toEqual([{ status: 'error', fence: 'v0' }]);
    expect(c.row.status).toBe('error');
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'j1',
        attempts: 3,
        rotated: true,
        markedNeedsReauth: true,
        errName: 'PrismaClientKnownRequestError',
      }),
      'integration token refresh could not store the rotated tokens; connection needs reauth',
    );
    expect(logged(l)).not.toMatch(SECRETS); // the thrown message carried the token; only its name is logged
  });

  it('a GitHub installation token that cannot be stored is retried next sweep, not marked needs-reauth', async () => {
    const c = connRepo('github');
    c.saveFailures.left = 99;
    const github = {
      createInstallationToken: vi.fn(async () => ({
        token: 'ghs_x',
        expiresAt: new Date(NOW + 3600e3),
      })),
    };
    const l = log();
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { github },
      log: l,
      saveAttempts: 2,
      sleep: async () => undefined,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(c.save).toHaveBeenCalledTimes(2);
    expect(c.statusCalls).toEqual([]);
    expect(logged(l)).not.toMatch(SECRETS);
  });
});

describe('token refresh hardening: lease Redis calls are time-bounded (item 2)', () => {
  const hung: LeaseRedis = { set: () => never(), eval: () => never() };

  it('an unreachable Redis fails acquire fast and logs, without calling the provider', async () => {
    const c = connRepo();
    const jira = { refresh: vi.fn() };
    const l = log();
    const started = Date.now();
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: l,
      lease: { acquire: () => never(), confirm: () => never(), release: () => never() },
      leaseOpTimeoutMs: 20,
      now: () => NOW,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(jira.refresh).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errName: 'LeaseTimeoutError' }),
      'integration token refresh lease unavailable',
    );
  });

  it('createRedisConnectionLease bounds every call (acquire, confirm, release)', async () => {
    const lease = createRedisConnectionLease(hung, () => 't', 20);
    await expect(lease.acquire(KEY, 1000)).rejects.toMatchObject({ name: 'LeaseTimeoutError' });
    await expect(lease.confirm(KEY, 't', 1000)).rejects.toMatchObject({
      name: 'LeaseTimeoutError',
    });
    await expect(lease.release(KEY, 't')).rejects.toMatchObject({ name: 'LeaseTimeoutError' });
  });

  it('a hung confirm counts as a lost lease and a hung release is logged; the sweep still finishes', async () => {
    const c = connRepo();
    const lease: ConnectionLease = {
      acquire: async () => 'tok',
      confirm: () => never(),
      release: () => never(),
    };
    const jira = {
      refresh: vi.fn(async () => ({
        accessToken: 'new-a',
        refreshToken: 'new-r',
        expiresAt: NOW + 3600e3,
      })),
    };
    const l = log();
    const r = await runTokenRefreshSweep({
      repo: c.repo,
      providers: { jira },
      log: l,
      lease,
      leaseOpTimeoutMs: 20,
      now: () => NOW,
    });
    expect(r).toEqual({ refreshed: 1, failed: 0, skipped: 0 }); // fenced save, nothing newer
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errName: 'LeaseTimeoutError' }),
      'integration token refresh lease check failed',
    );
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errName: 'LeaseTimeoutError' }),
      'integration token refresh lease release failed',
    );
  });

  it('the lease connection is fail-fast and logs a Redis outage once until it recovers', () => {
    expect(LEASE_REDIS_OPTIONS.maxRetriesPerRequest).toBe(1);
    expect(LEASE_REDIS_OPTIONS.commandTimeout).toBeGreaterThan(0);
    const handlers: Record<string, (e?: unknown) => void> = {};
    const l = log();
    watchLeaseRedis({ on: (ev: string, fn: (e?: unknown) => void) => (handlers[ev] = fn) }, l);
    const econn = Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' });
    handlers.error!(econn);
    handlers.error!(econn);
    expect(l.warn).toHaveBeenCalledTimes(1);
    handlers.ready!();
    handlers.error!(econn);
    expect(l.warn).toHaveBeenCalledTimes(2);
    expect(l.info).toHaveBeenCalledWith({}, 'integration token refresh lease redis reconnected');
  });
});

describe('INTEGRATIONS_API_ORIGIN (item 6)', () => {
  const prod = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  it('is required in production, with no localhost default', () => {
    expect(() => integrationsApiOrigin(prod)).toThrow(IntegrationsApiOriginError);
    expect(() => integrationsApiOrigin(prod)).toThrow(
      /INTEGRATIONS_API_ORIGIN is required when NODE_ENV=production/,
    );
    expect(() =>
      integrationsApiOrigin({ ...prod, INTEGRATIONS_API_ORIGIN: 'http://api.example.com' }),
    ).toThrow(/https/);
    expect(() =>
      integrationsApiOrigin({ ...prod, INTEGRATIONS_API_ORIGIN: 'https://api.example.com/v1' }),
    ).toThrow(/bare origin/);
    expect(() => integrationsApiOrigin({ ...prod, INTEGRATIONS_API_ORIGIN: 'not a url' })).toThrow(
      /absolute https origin/,
    );
    expect(
      integrationsApiOrigin({ ...prod, INTEGRATIONS_API_ORIGIN: ' https://api.example.com/ ' }),
    ).toBe('https://api.example.com');
  });
  it('defaults to the local API outside production', () => {
    expect(integrationsApiOrigin({ NODE_ENV: 'development' })).toBe('http://localhost:4000');
    expect(
      integrationsApiOrigin({
        INTEGRATIONS_API_ORIGIN: 'http://localhost:4100',
      }),
    ).toBe('http://localhost:4100');
  });
  it('the Jira refresh client and the Google calendar provider fail startup with a clear error in production', () => {
    const jiraEnv = { ...prod, JIRA_CLIENT_ID: 'id', JIRA_CLIENT_SECRET: 's' };
    expect(() => tokenRefreshProvidersFromEnv(jiraEnv)).toThrow(TokenRefreshEnvError);
    expect(() => tokenRefreshProvidersFromEnv(jiraEnv)).toThrow(
      /INTEGRATIONS_API_ORIGIN is required/,
    );
    expect(
      tokenRefreshProvidersFromEnv({
        ...jiraEnv,
        INTEGRATIONS_API_ORIGIN: 'https://api.example.com',
      }).jira,
    ).toBeDefined();
    const gEnv = { ...prod, GOOGLE_CALENDAR_CLIENT_ID: 'id', GOOGLE_CALENDAR_CLIENT_SECRET: 's' };
    expect(() => calendarSyncProvidersFromEnv(gEnv)).toThrow(CalendarSyncEnvError);
    expect(
      calendarSyncProvidersFromEnv({ ...gEnv, INTEGRATIONS_API_ORIGIN: 'https://api.example.com' })
        .google,
    ).toBeDefined();
  });
});
