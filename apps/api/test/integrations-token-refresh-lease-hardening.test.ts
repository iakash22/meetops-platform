import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tokenRefreshLeaseKey, type ConnectionLease } from '@meetops/integrations';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import {
  devIntegrationsRuntime,
  type IntegrationsRuntime,
} from '../src/modules/integrations/runtime.js';
import {
  IntegrationsService,
  JIRA_REFRESH_TIMEOUT_MS,
  LEASE_WAIT_MS,
  mapProviderError,
} from '../src/modules/integrations/service.js';
import { ProviderUpstreamError } from '../src/modules/integrations/errors.js';

/**
 * Tester findings on #378 (API on-demand Jira refresh under the shared lease): M1 concurrency and lease expiry
 * mid-refresh, L3 warning on a failed confirm, L4 the injected clock bounds the wait, L5 the 30 s refresh abort.
 */
const ORG = randomUUID();
const CLOUD = '11111111-2222-4333-8444-555555555555';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const NOW = Date.now();

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Token endpoint: counts calls, can be held open, and honours the abort signal like a real fetch. */
function tokenEndpoint() {
  let calls = 0;
  let gate: Promise<void> | undefined;
  const inFlight = deferred();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== TOKEN_URL) return new Response('{}', { status: 500 });
    calls++;
    inFlight.resolve();
    const signal = init?.signal;
    if (gate)
      await new Promise<void>((resolve, reject) => {
        void gate!.then(resolve);
        signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    return new Response(
      JSON.stringify({
        access_token: 'api-access',
        refresh_token: 'api-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read:jira-work write:jira-work read:jira-user offline_access',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return {
    calls: () => calls,
    fetch,
    inFlight: inFlight.promise,
    hold() {
      const d = deferred();
      gate = d.promise;
      return d.resolve;
    },
  };
}

/** SET NX semantics in memory; `expire(key)` drops a lease as a PX timeout would. */
function memoryLease(over: Partial<ConnectionLease> = {}) {
  const held = new Map<string, string>();
  const lease: ConnectionLease = {
    async acquire(key) {
      if (held.has(key)) return null;
      const t = randomUUID();
      held.set(key, t);
      return t;
    },
    async confirm(key, token) {
      return held.get(key) === token;
    },
    async release(key, token) {
      if (held.get(key) !== token) return false;
      held.delete(key);
      return true;
    },
    ...over,
  };
  return { lease, held };
}

function setup(over: Partial<IntegrationsRuntime> = {}, expiresInMs = 30_000) {
  const repo = new InMemoryIntegrations();
  const ep = tokenEndpoint();
  const id = randomUUID();
  repo.add(
    {
      id,
      organizationId: ORG,
      provider: 'jira',
      status: 'active',
      displayName: 'acme.atlassian.net',
      externalAccountId: CLOUD,
      connectedById: randomUUID(),
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    },
    { accessToken: 'old-access', refreshToken: 'old-refresh', webhookSecret: 'whs' },
    new Date(NOW + expiresInMs),
  );
  const warn = vi.fn();
  const rt = devIntegrationsRuntime({
    fetch: ep.fetch,
    now: () => NOW,
    jira: { clientId: 'jira-client', clientSecret: async () => 'jira-secret' },
    ...over,
  });
  const service = new IntegrationsService(repo, rt, { warn });
  const conn = async () => (await repo.get(ORG, id))!;
  const key = tokenRefreshLeaseKey(ORG, id);
  const workerSaves = async (access: string) => {
    const snap = (await repo.readForRefresh(ORG, id))!;
    return repo.saveRefreshedTokens(
      ORG,
      id,
      {
        accessToken: access,
        refreshToken: `${access}-refresh`,
        webhookSecret: snap.secrets.webhookSecret,
        accessTokenExpiresAt: new Date(NOW + 3_600_000),
      },
      snap.fence,
    );
  };
  return { repo, ep, id, key, service, conn, warn, workerSaves };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('#378 M1: concurrent on-demand refreshes', () => {
  it('Promise.all of many requests on an expired token makes exactly one provider refresh', async () => {
    const m = memoryLease();
    const clock = NOW + 60_000; // token already expired: waiters must wait for the holder's save
    const s = setup({
      tokenRefreshLease: m.lease,
      now: () => clock,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
    });
    const release = s.ep.hold();
    const conn = await s.conn();
    const all = Promise.all(Array.from({ length: 8 }, () => s.service.jiraAccessToken(conn)));
    await s.ep.inFlight;
    release();
    const tokens = await all;
    expect(tokens).toEqual(Array(8).fill('api-access'));
    expect(s.ep.calls()).toBe(1);
    expect(m.held.size).toBe(0);
    expect(s.repo.secrets.get(s.id)).toMatchObject({ refreshToken: 'api-refresh' });
  });

  it('without a lease (dev) concurrent requests still never overwrite each other: losers are superseded', async () => {
    const s = setup();
    const save = vi.spyOn(s.repo, 'saveRefreshedTokens');
    const release = s.ep.hold();
    const conn = await s.conn();
    const all = Promise.all([s.service.jiraAccessToken(conn), s.service.jiraAccessToken(conn)]);
    await s.ep.inFlight;
    release();
    await all;
    const results = await Promise.all(save.mock.results.map((r) => r.value as Promise<string>));
    expect(results.filter((r) => r === 'saved')).toHaveLength(1);
    expect(results.filter((r) => r === 'superseded')).toHaveLength(results.length - 1);
  });

  it('the lease expires during a slow refresh and the worker refreshes meanwhile: the save is superseded', async () => {
    const m = memoryLease();
    const s = setup({ tokenRefreshLease: m.lease });
    const save = vi.spyOn(s.repo, 'saveRefreshedTokens');
    const release = s.ep.hold();
    const pending = s.service.jiraAccessToken(await s.conn());
    await s.ep.inFlight;
    // Our lease TTL ran out (PX expiry) and the worker took it and saved its own rotated pair.
    m.held.set(s.key, 'worker-lease');
    expect(await s.workerSaves('worker-access')).toBe('saved');
    release();
    await expect(pending).resolves.toBe('worker-access');
    await expect(save.mock.results.at(-1)!.value).resolves.toBe('superseded');
    expect(s.repo.secrets.get(s.id)).toMatchObject({ accessToken: 'worker-access' });
    expect(m.held.get(s.key)).toBe('worker-lease'); // never released the worker's lease
    // #378 L3: the lost lease is logged, without any token material.
    expect(s.warn).toHaveBeenCalledWith(
      { integrationId: s.id, provider: 'jira', reason: 'lease_lost' },
      expect.stringContaining('lease could not be confirmed'),
    );
    expect(JSON.stringify(s.warn.mock.calls)).not.toMatch(/access|refresh-|worker-lease/);
  });
});

describe('#378 L3: confirm failures are logged', () => {
  it('a confirm that throws is logged and the fenced save still proceeds', async () => {
    const m = memoryLease({
      confirm: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const s = setup({ tokenRefreshLease: m.lease });
    await expect(s.service.jiraAccessToken(await s.conn())).resolves.toBe('api-access');
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.warn.mock.calls[0]![0]).toEqual({
      integrationId: s.id,
      provider: 'jira',
      reason: 'confirm_failed:Error',
    });
    expect(m.held.size).toBe(0);
  });

  it('a successful confirm logs nothing', async () => {
    const s = setup({ tokenRefreshLease: memoryLease().lease });
    await s.service.jiraAccessToken(await s.conn());
    expect(s.warn).not.toHaveBeenCalled();
  });
});

describe('#378 L4: the wait for another holder uses the injected clock', () => {
  it('ends in a 502 once the injected now() passes the 5 s wait, without a provider call', async () => {
    const m = memoryLease();
    let clock = NOW + 60_000; // expired, and the worker holds the lease but never saves
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const s = setup({ tokenRefreshLease: m.lease, now: () => clock, sleep });
    m.held.set(s.key, 'worker-lease');
    const start = clock;
    await expect(s.service.jiraAccessToken(await s.conn())).rejects.toBeInstanceOf(
      ProviderUpstreamError,
    );
    expect(clock - start).toBeGreaterThanOrEqual(LEASE_WAIT_MS);
    expect(clock - start).toBeLessThan(LEASE_WAIT_MS + 1_000);
    expect(sleep).toHaveBeenCalledTimes(LEASE_WAIT_MS / 250);
    expect(s.ep.calls()).toBe(0);
  });
});

describe('#378 L5: the provider refresh is bounded (30 s outer abort, 10 s client deadline)', () => {
  /**
   * The service arms a JIRA_REFRESH_TIMEOUT_MS (30 s) AbortController around the refresh, but JiraOAuthClient's own
   * per-request deadline (timeoutMs, default 10 s) always fires first, so in practice the refresh fails at 10 s.
   * These tests pin both bounds: a hung refresh never outlives the 30 s cap, and the cap's timer never leaks.
   */
  it('a hung token request fails well before 30 s, writes nothing, releases the lease and maps to 502', async () => {
    expect(JIRA_REFRESH_TIMEOUT_MS).toBe(30_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const m = memoryLease();
    const s = setup({ tokenRefreshLease: m.lease });
    s.ep.hold(); // never answers
    let signal: AbortSignal | undefined;
    const inner = s.ep.fetch;
    const rt = (s.service as unknown as { rt: IntegrationsRuntime }).rt;
    rt.fetch = (input, init) => {
      signal = init?.signal ?? undefined;
      return inner(input, init);
    };
    const outcome = s.service.jiraAccessToken(await s.conn()).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await s.ep.inFlight;
    expect(signal?.aborted).toBe(false);
    expect(m.held.size).toBe(1);
    await vi.advanceTimersByTimeAsync(JIRA_REFRESH_TIMEOUT_MS);
    const err = await outcome;
    expect(err).not.toBe('resolved');
    expect(signal?.aborted).toBe(true);
    expect(mapProviderError(err)).toBeInstanceOf(ProviderUpstreamError);
    expect(s.repo.secrets.get(s.id)).toMatchObject({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    });
    expect(m.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // the 30 s abort timer was cleared, not left running
  });

  it('a normal refresh clears the 30 s abort timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = setup();
    await expect(s.service.jiraAccessToken(await s.conn())).resolves.toBe('api-access');
    expect(vi.getTimerCount()).toBe(0);
  });
});
