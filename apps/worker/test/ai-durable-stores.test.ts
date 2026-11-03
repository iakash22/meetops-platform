import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryIdempotencyStore,
  InMemoryOrgConfigStore,
  InMemoryUsageTracker,
} from '@meetops/ai-core';
import type {
  AiIdempotencyRepository,
  AiOrgConfigRecord,
  AiOrgConfigRepository,
  AiUsageCounterRepository,
} from '@meetops/database';
import {
  PostgresIdempotencyStore,
  PostgresOrgConfigStore,
  PostgresUsageTracker,
  createAiStores,
} from '../src/ai/durable-stores.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';

describe('createAiStores (config/DI)', () => {
  it('defaults to durable Postgres stores', () => {
    const s = createAiStores({});
    expect(s.mode).toBe('durable');
    expect(s.usage).toBeInstanceOf(PostgresUsageTracker);
    expect(s.idempotency).toBeInstanceOf(PostgresIdempotencyStore);
    expect(s.orgConfig).toBeInstanceOf(PostgresOrgConfigStore);
  });

  it('memory only when asked explicitly, and never in production', () => {
    const s = createAiStores({ AI_STORES: 'memory', NODE_ENV: 'test' });
    expect(s.usage).toBeInstanceOf(InMemoryUsageTracker);
    expect(s.idempotency).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(s.orgConfig).toBeInstanceOf(InMemoryOrgConfigStore);
    expect(() => createAiStores({ AI_STORES: 'memory', NODE_ENV: 'production' })).toThrow(
      /not allowed/,
    );
    expect(createAiStores({ NODE_ENV: 'production' }).mode).toBe('durable');
  });

  it('an unknown value is an error, not a fallback', () => {
    expect(() => createAiStores({ AI_STORES: 'redis' })).toThrow(/AI_STORES/);
    // The message names the variable only, never the raw value.
    const secretish = 'postgres://user:pw@host/db';
    let msg = '';
    try {
      createAiStores({ AI_STORES: secretish });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/AI_STORES/);
    expect(msg).not.toContain(secretish);
    expect(msg).not.toContain('pw@');
  });
});

describe('PostgresUsageTracker', () => {
  it('records into the UTC day bucket and maps totals', async () => {
    const increment = vi.fn(async () => ({}) as never);
    const repo = {
      increment,
      providerTotalsSince: vi.fn(async () => ({
        requests: 3,
        inputTokens: 10n,
        outputTokens: 5n,
        audioSeconds: '1.500',
        costUsd: '0.000120',
      })),
      organizationCostSince: vi.fn(async () => '0.250000'),
    } as unknown as AiUsageCounterRepository;
    const t = new PostgresUsageTracker(repo);
    await t.record({
      organizationId: ORG,
      provider: 'gemini',
      model: 'm',
      feature: 'summary',
      at: '2026-10-31T23:59:00.000Z',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        audioSeconds: 1.5,
        estimatedCostUsd: 0.00012,
      },
    });
    expect(increment).toHaveBeenCalledWith(ORG, {
      provider: 'gemini',
      periodKind: 'day',
      periodStart: new Date('2026-10-31T00:00:00.000Z'),
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      audioSeconds: '1.500',
      costUsd: '0.000120',
    });
    expect(
      await t.totals({
        organizationId: ORG,
        provider: 'gemini',
        since: new Date('2026-10-01T00:00:00Z'),
      }),
    ).toEqual({
      requests: 3,
      tokens: 15,
      audioSeconds: 1.5,
      costUsd: 0.00012,
    });
    expect(await t.organizationCostSince(ORG, new Date('2026-10-01T00:00:00Z'))).toBe(0.25);
  });

  it('propagates store errors (fail closed)', async () => {
    const repo = {
      increment: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as AiUsageCounterRepository;
    await expect(
      new PostgresUsageTracker(repo).record({
        organizationId: ORG,
        provider: 'p',
        model: 'm',
        feature: 'summary',
        at: new Date().toISOString(),
        usage: { estimatedCostUsd: 0 },
      }),
    ).rejects.toThrow('db down');
  });
});

describe('PostgresIdempotencyStore', () => {
  it('serializes results and re-claims a key only after purging an expired row', async () => {
    const storeResult = vi.fn(async () => undefined);
    const purgeExpired = vi.fn(async () => true);
    const release = vi.fn(async () => true);
    const repo = {
      getResult: vi.fn(async () => '{"status":"succeeded"}'),
      storeResult,
      claim: vi
        .fn(async () => false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      purgeExpired,
      release,
    } as unknown as AiIdempotencyRepository;
    const s = new PostgresIdempotencyStore(repo);
    expect(await s.get(ORG, 'k')).toEqual({ status: 'succeeded' });
    await s.set(ORG, 'k', { a: 1 }, 60);
    expect(storeResult).toHaveBeenCalledWith(ORG, 'k', '{"a":1}', 60_000);
    expect(await s.claim(ORG, 'k', 30)).toBe(true);
    expect(purgeExpired).toHaveBeenCalledWith(ORG, 'k');
    await s.release(ORG, 'k');
    expect(release).toHaveBeenCalledWith(ORG, 'k');
  });
});

describe('PostgresOrgConfigStore', () => {
  const fakeRepo = (initial?: AiOrgConfigRecord) => {
    let row = initial;
    const upsert = vi.fn(
      async (_org: string, input: { config: object; monthlyBudgetUsd?: string | number }) => {
        row = {
          config: JSON.parse(JSON.stringify(input.config)),
          monthlyBudgetUsd:
            input.monthlyBudgetUsd === undefined ? undefined : String(input.monthlyBudgetUsd),
        };
      },
    );
    const get = vi.fn(async () => row);
    return { repo: { get, upsert } as unknown as AiOrgConfigRepository, get, upsert };
  };

  it('returns undefined when no row exists', async () => {
    const { repo, get } = fakeRepo();
    expect(await new PostgresOrgConfigStore(repo).get(ORG)).toBeUndefined();
    expect(get).toHaveBeenCalledWith(ORG);
  });

  it('round-trips a config; budget goes to its own column, org id is the row key', async () => {
    const { repo, upsert } = fakeRepo();
    const store = new PostgresOrgConfigStore(repo);
    const cfg = {
      organizationId: ORG,
      defaults: { llm: { provider: 'gemini', model: 'gemini-2.5-flash' } },
      features: {},
      approvedProviders: ['gemini'],
      allowPaidFallback: false,
      monthlyBudgetUsd: 25,
      credentialRefs: { gemini: `secret:org/${ORG}/gemini` },
    };
    await store.put(cfg);
    const [org, input] = upsert.mock.calls[0]!;
    expect(org).toBe(ORG);
    expect(input.monthlyBudgetUsd).toBe('25.00');
    expect(input.config).not.toHaveProperty('organizationId');
    expect(input.config).not.toHaveProperty('monthlyBudgetUsd');
    expect(await store.get(ORG)).toEqual(cfg);
  });

  it('uses the queried organization id, never one stored in the JSON', async () => {
    const other = '00000000-0000-4000-8000-0000000000b2';
    const { repo } = fakeRepo({ config: { organizationId: other }, monthlyBudgetUsd: undefined });
    const got = await new PostgresOrgConfigStore(repo).get(ORG);
    expect(got?.organizationId).toBe(ORG);
    expect(got?.monthlyBudgetUsd).toBeUndefined();
  });

  it('a malformed stored row fails closed without echoing values', async () => {
    const { repo } = fakeRepo({
      config: { credentialRefs: { gemini: 'sk-live-should-not-leak' } },
      monthlyBudgetUsd: undefined,
    });
    const err = await new PostgresOrgConfigStore(repo).get(ORG).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid/);
    expect((err as Error).message).not.toContain('sk-live');
  });

  it('repository errors propagate (no fallback)', async () => {
    const repo = {
      get: vi.fn(async () => {
        throw new Error('db down');
      }),
      upsert: vi.fn(),
    } as unknown as AiOrgConfigRepository;
    await expect(new PostgresOrgConfigStore(repo).get(ORG)).rejects.toThrow('db down');
  });
});
