import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  LeaseTimeoutError,
  TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
  tokenRefreshLeaseKey,
  type ConnectionLease,
} from '@meetops/integrations';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import {
  devIntegrationsRuntime,
  type IntegrationsRuntime,
} from '../src/modules/integrations/runtime.js';
import {
  IntegrationsService,
  JIRA_REFRESH_TIMEOUT_MS,
  mapProviderError,
} from '../src/modules/integrations/service.js';
import { ProviderUpstreamError } from '../src/modules/integrations/errors.js';

/**
 * #382 follow-ups: (1) a lease confirm that HANGS (not throws) is cut off by boundedLeaseOp
 * (TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS), logged, and the fenced save still runs; (2) the service's own 30 s
 * refresh abort, exercised with a client stub that has no timeout of its own (JiraOAuthClient's 10 s deadline
 * otherwise always fires first, so #382 could not reach this path).
 */
const ORG = randomUUID();
const CLOUD = '11111111-2222-4333-8444-555555555555';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const NOW = Date.now();

const okToken = () =>
  new Response(
    JSON.stringify({
      access_token: 'api-access',
      refresh_token: 'api-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read:jira-work write:jira-work read:jira-user offline_access',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

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

function setup(over: Partial<IntegrationsRuntime> = {}) {
  const repo = new InMemoryIntegrations();
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
    new Date(NOW + 30_000),
  );
  const warn = vi.fn();
  const rt = devIntegrationsRuntime({
    fetch: async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url === TOKEN_URL ? okToken() : new Response('{}', { status: 500 });
    },
    now: () => NOW,
    jira: { clientId: 'jira-client', clientSecret: async () => 'jira-secret' },
    ...over,
  });
  const service = new IntegrationsService(repo, rt, { warn });
  const conn = async () => (await repo.get(ORG, id))!;
  return { repo, id, key: tokenRefreshLeaseKey(ORG, id), service, conn, warn };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('#382 follow-up: a hanging lease confirm (boundedLeaseOp timeout path)', () => {
  it('times out after TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS, logs confirm_failed:LeaseTimeoutError, still saves and releases', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let confirmCalled!: () => void;
    const confirming = new Promise<void>((r) => (confirmCalled = r));
    const m = memoryLease({
      confirm: () => {
        confirmCalled();
        return new Promise<boolean>(() => {}); // Redis stalled: never answers
      },
    });
    const release = vi.spyOn(m.lease, 'release');
    const s = setup({ tokenRefreshLease: m.lease });
    const save = vi.spyOn(s.repo, 'saveRefreshedTokens');
    let settled = false;
    const pending = s.service.jiraAccessToken(await s.conn()).finally(() => (settled = true));
    await confirming;
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(save).not.toHaveBeenCalled(); // no write while confirm is still pending
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('api-access');
    expect(s.warn).toHaveBeenCalledTimes(1);
    expect(s.warn.mock.calls[0]![0]).toEqual({
      integrationId: s.id,
      provider: 'jira',
      reason: `confirm_failed:${new LeaseTimeoutError().name}`,
    });
    expect(save).toHaveBeenCalledTimes(1);
    await expect(save.mock.results[0]!.value).resolves.toBe('saved');
    expect(release).toHaveBeenCalledTimes(1);
    expect(m.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('#382 follow-up: the 30 s refresh abort with a client that has no timeout of its own', () => {
  it('aborts exactly at JIRA_REFRESH_TIMEOUT_MS, writes nothing, releases the lease and maps to 502', async () => {
    expect(JIRA_REFRESH_TIMEOUT_MS).toBe(30_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const m = memoryLease();
    const s = setup({ tokenRefreshLease: m.lease });
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const inFlight = new Promise<void>((r) => (started = r));
    // Stub client: no deadline of its own, only honours the caller's signal.
    const refresh = vi.fn(
      (_rt: string, opts?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          signal = opts?.signal;
          started();
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    vi.spyOn(s.service as unknown as { jiraClient: () => unknown }, 'jiraClient').mockReturnValue({
      refresh,
    });
    const save = vi.spyOn(s.repo, 'saveRefreshedTokens');
    const outcome = s.service.jiraAccessToken(await s.conn()).then(
      () => 'resolved' as const,
      (e: unknown) => e,
    );
    await inFlight;
    expect(refresh).toHaveBeenCalledWith('old-refresh', { signal: expect.any(AbortSignal) });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false); // nothing else cut it off before 30 s
    expect(m.held.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const err = await outcome;
    expect(err).not.toBe('resolved');
    expect((err as Error).name).toBe('AbortError');
    expect(mapProviderError(err)).toBeInstanceOf(ProviderUpstreamError);
    expect(save).not.toHaveBeenCalled();
    expect(s.repo.secrets.get(s.id)).toMatchObject({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
    });
    expect(m.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
