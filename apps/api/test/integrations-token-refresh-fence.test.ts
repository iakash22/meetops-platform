import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  TOKEN_REFRESH_LEASE_TTL_MS,
  tokenRefreshLeaseKey,
  type ConnectionLease,
} from '@meetops/integrations';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import {
  ACQUIRE_LEASE_LUA,
  devIntegrationsRuntime,
  leaseRedisFromEval,
  refusingTokenRefreshLease,
  type IntegrationsRuntime,
} from '../src/modules/integrations/runtime.js';
import { withTokenRefreshLease } from '../src/modules/integrations/index.js';
import { IntegrationsService } from '../src/modules/integrations/service.js';
import {
  IntegrationNotConnectedError,
  ProviderUpstreamError,
} from '../src/modules/integrations/errors.js';
import type { ModuleDeps } from '../src/modules/index.js';

/**
 * #375 Tester F1 (MEDIUM): the API's on-demand Jira refresh (IntegrationsService.jiraAccessToken) used to save with
 * an unfenced `upsert` and no lease. It could overwrite newer tokens saved by the worker sweep, and a refresh in
 * flight during a disconnect re-activated the revoked connection (upsert sets status active). It now takes the same
 * per-connection lease as the worker and saves with the fenced compare-and-swap; disconnect moves the fence.
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

/** Jira token endpoint that can be held open, so a test can act while a refresh is in flight. */
function tokenEndpoint() {
  const calls: string[] = [];
  let gate: Promise<void> | undefined;
  const inFlight = deferred();
  const fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (url !== TOKEN_URL) return new Response('{}', { status: 500 });
    inFlight.resolve();
    if (gate) await gate;
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
    calls,
    fetch,
    inFlight: inFlight.promise,
    hold() {
      const d = deferred();
      gate = d.promise;
      return d.resolve;
    },
  };
}

/** In-memory lease with the same SET NX semantics; `heldElsewhere` simulates the worker holding it. */
function memoryLease(over: Partial<ConnectionLease> = {}) {
  const held = new Map<string, string>();
  const ops: string[] = [];
  const lease: ConnectionLease = {
    async acquire(key) {
      ops.push(`acquire ${key}`);
      if (held.has(key)) return null;
      const t = randomUUID();
      held.set(key, t);
      return t;
    },
    async confirm(key, token) {
      ops.push(`confirm ${key}`);
      return held.get(key) === token;
    },
    async release(key, token) {
      ops.push(`release ${key}`);
      if (held.get(key) !== token) return false;
      held.delete(key);
      return true;
    },
    ...over,
  };
  return { lease, held, ops };
}

function setup(over: Partial<IntegrationsRuntime> = {}) {
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
    new Date(NOW + 30_000), // inside the 120 s refresh skew
  );
  const rt = devIntegrationsRuntime({
    fetch: ep.fetch,
    now: () => NOW,
    jira: { clientId: 'jira-client', clientSecret: async () => 'jira-secret' },
    ...over,
  });
  const service = new IntegrationsService(repo, rt);
  const conn = async () => (await repo.get(ORG, id))!;
  /** What the worker sweep does: fenced save of its own rotated pair. */
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
  return { repo, ep, id, service, conn, workerSaves };
}
const tokenCalls = (calls: string[]) => calls.filter((u) => u === TOKEN_URL).length;

describe('API on-demand Jira refresh: fenced save (#375 F1)', () => {
  it('a stale refresh does not overwrite newer tokens the worker saved meanwhile', async () => {
    const s = setup();
    const release = s.ep.hold();
    const pending = s.service.jiraAccessToken(await s.conn());
    await s.ep.inFlight;
    expect(await s.workerSaves('worker-access')).toBe('saved'); // the worker wins the race
    release();
    // The API's save is superseded; it uses the stored (worker) token instead of its own stale pair.
    await expect(pending).resolves.toBe('worker-access');
    expect(s.repo.secrets.get(s.id)).toMatchObject({
      accessToken: 'worker-access',
      refreshToken: 'worker-access-refresh',
    });
    expect(s.repo.rows.get(s.id)!.status).toBe('active');
  });

  it('a disconnect while a refresh is in flight stays revoked (no reactivation, secrets stay wiped)', async () => {
    const s = setup();
    const release = s.ep.hold();
    const pending = s.service.jiraAccessToken(await s.conn());
    await s.ep.inFlight;
    await s.repo.disconnect(ORG, s.id);
    release();
    await expect(pending).rejects.toBeInstanceOf(IntegrationNotConnectedError);
    expect(s.repo.rows.get(s.id)!.status).toBe('revoked');
    expect(s.repo.secrets.get(s.id)).toBe(false);
    expect(await s.repo.readForRefresh(ORG, s.id)).toBeNull();
  });

  it('disconnect moves the fence (generation): a save fenced before it is superseded', async () => {
    const s = setup();
    const before = (await s.repo.readForRefresh(ORG, s.id))!;
    await s.repo.disconnect(ORG, s.id);
    expect(
      await s.repo.saveRefreshedTokens(
        ORG,
        s.id,
        {
          accessToken: 'late',
          refreshToken: 'late-r',
          webhookSecret: 'whs',
          accessTokenExpiresAt: null,
        },
        before.fence,
      ),
    ).toBe('superseded');
    expect(s.repo.rows.get(s.id)!.status).toBe('revoked');
  });

  it('with no race it saves the rotated pair under the fence and returns it', async () => {
    const s = setup();
    await expect(s.service.jiraAccessToken(await s.conn())).resolves.toBe('api-access');
    expect(s.repo.secrets.get(s.id)).toMatchObject({
      accessToken: 'api-access',
      refreshToken: 'api-refresh',
      webhookSecret: 'whs',
    });
    expect(tokenCalls(s.ep.calls)).toBe(1);
  });
});

describe('API on-demand Jira refresh: shared lease (#375 F1)', () => {
  it('takes the worker key, re-confirms before saving and releases', async () => {
    const m = memoryLease();
    const s = setup({ tokenRefreshLease: m.lease });
    await expect(s.service.jiraAccessToken(await s.conn())).resolves.toBe('api-access');
    const key = tokenRefreshLeaseKey(ORG, s.id);
    expect(m.ops).toEqual([`acquire ${key}`, `confirm ${key}`, `release ${key}`]);
    expect(m.held.size).toBe(0);
  });

  it('while the worker holds the lease it never calls the provider; it waits for the worker save', async () => {
    const m = memoryLease();
    const sleep = vi.fn();
    const s = setup({ tokenRefreshLease: m.lease, sleep, now: () => NOW + 60_000 }); // token already expired
    m.held.set(tokenRefreshLeaseKey(ORG, s.id), 'worker-lease');
    sleep.mockImplementation(async () => {
      await s.workerSaves('worker-access');
    });
    await expect(s.service.jiraAccessToken(await s.conn())).resolves.toBe('worker-access');
    expect(tokenCalls(s.ep.calls)).toBe(0); // no second use of the rotating grant
    expect(m.held.get(tokenRefreshLeaseKey(ORG, s.id))).toBe('worker-lease'); // never released theirs
  });

  it('while the worker holds the lease, a not-yet-expired token is used as is', async () => {
    const m = memoryLease();
    const s = setup({ tokenRefreshLease: m.lease });
    m.held.set(tokenRefreshLeaseKey(ORG, s.id), 'worker-lease');
    await expect(s.service.jiraAccessToken(await s.conn())).resolves.toBe('old-access');
    expect(tokenCalls(s.ep.calls)).toBe(0);
  });

  it('fails closed when the lease store errors: transient 502, no provider call, nothing written', async () => {
    const m = memoryLease({
      acquire: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const s = setup({ tokenRefreshLease: m.lease });
    await expect(s.service.jiraAccessToken(await s.conn())).rejects.toBeInstanceOf(
      ProviderUpstreamError,
    );
    expect(tokenCalls(s.ep.calls)).toBe(0);
    expect(s.repo.secrets.get(s.id)).toMatchObject({ accessToken: 'old-access' });
  });

  it('a refresh that already landed under another holder is reused after taking the lease', async () => {
    const m = memoryLease();
    const s = setup({ tokenRefreshLease: m.lease });
    const conn = await s.conn(); // read before the worker saved
    await s.workerSaves('worker-access');
    await expect(s.service.jiraAccessToken(conn)).resolves.toBe('worker-access');
    expect(tokenCalls(s.ep.calls)).toBe(0);
  });
});

describe('API token-refresh lease wiring', () => {
  const rt = () => devIntegrationsRuntime();
  it('uses deps.redis (SET NX PX via eval) when present', async () => {
    const evals: unknown[][] = [];
    const redis = {
      eval: vi.fn(async (...a: unknown[]) => {
        evals.push(a);
        return a[0] === ACQUIRE_LEASE_LUA ? 'OK' : 1;
      }),
    } as unknown as NonNullable<ModuleDeps['redis']>;
    const wired = withTokenRefreshLease(rt(), { redis }, 'production');
    const token = await wired.tokenRefreshLease!.acquire('k', TOKEN_REFRESH_LEASE_TTL_MS);
    expect(token).toEqual(expect.any(String));
    expect(evals[0]).toEqual([
      ACQUIRE_LEASE_LUA,
      1,
      'k',
      token,
      String(TOKEN_REFRESH_LEASE_TTL_MS),
    ]);
    expect(ACQUIRE_LEASE_LUA).toMatch(/'SET', KEYS\[1\], ARGV\[1\], 'PX', ARGV\[2\], 'NX'/);
  });
  it('a nil SET NX reply means held elsewhere', async () => {
    const lr = leaseRedisFromEval({ eval: async () => null });
    expect(await lr.set('k', 'v', 'PX', 1000, 'NX')).toBeNull();
  });
  it.each(['production', 'staging', undefined])(
    'NODE_ENV=%s without Redis refuses to refresh (fail closed)',
    (nodeEnv) => {
      expect(withTokenRefreshLease(rt(), {}, nodeEnv).tokenRefreshLease).toBe(
        refusingTokenRefreshLease,
      );
    },
  );
  it('development/test without Redis relies on the fenced save alone', () => {
    for (const nodeEnv of ['development', 'test'])
      expect(withTokenRefreshLease(rt(), {}, nodeEnv).tokenRefreshLease).toBeUndefined();
  });
  it('keeps an injected lease', () => {
    const { lease } = memoryLease();
    const r = { ...rt(), tokenRefreshLease: lease };
    expect(withTokenRefreshLease(r, {}, 'production')).toBe(r);
  });
});
