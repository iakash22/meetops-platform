import { describe, expect, it, vi } from 'vitest';
import { InMemoryIdempotencyStore, InMemoryUsageTracker } from '@meetops/ai-core';
import type { AiIdempotencyRepository, AiUsageCounterRepository } from '@meetops/database';
import {
  PostgresIdempotencyStore,
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
  });

  it('memory only when asked explicitly, and never in production', () => {
    const s = createAiStores({ AI_STORES: 'memory', NODE_ENV: 'test' });
    expect(s.usage).toBeInstanceOf(InMemoryUsageTracker);
    expect(s.idempotency).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(() => createAiStores({ AI_STORES: 'memory', NODE_ENV: 'production' })).toThrow(
      /not allowed/,
    );
    expect(createAiStores({ NODE_ENV: 'production' }).mode).toBe('durable');
  });

  it('an unknown value is an error, not a fallback', () => {
    expect(() => createAiStores({ AI_STORES: 'redis' })).toThrow(/AI_STORES/);
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
