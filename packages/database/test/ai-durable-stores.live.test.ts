/**
 * Live tests for the durable AI stores the worker uses (PostgresUsageTracker / PostgresIdempotencyStore sit
 * directly on these repository calls): persistence across a "restart" (a brand-new PrismaClient/pool),
 * single-winner duplicate claims under concurrency, result storage/release/expiry, and cross-organization
 * isolation under forced RLS. Runs as meetops_app. Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL
 * point at a migrated database (see docs/ci-live-db.md).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createAiIdempotencyRepository,
  createAiOrgConfigRepository,
  createAiUsageCounterRepository,
} from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const withPool = (url: string) => `${url}${url.includes('?') ? '&' : '?'}connection_limit=12`;
const newApp = () => new PrismaClient({ datasources: { db: { url: withPool(APP_URL ?? '') } } });

describe.skipIf(!APP_URL || !OWNER_URL)('durable AI stores (live)', () => {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const clients: PrismaClient[] = [];
  const app = () => {
    const c = newApp();
    clients.push(c);
    return c;
  };
  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'Durable A', slug: `durable-a-${orgA}` },
        { id: orgB, name: 'Durable B', slug: `durable-b-${orgB}` },
      ],
    });
  });

  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await Promise.all(clients.map((c) => c.$disconnect()));
    await owner.$disconnect();
  });

  it('usage survives a restart (new client) and totals are per provider and per org', async () => {
    const before = createAiUsageCounterRepository({ client: app() });
    const day = new Date(Date.UTC(2026, 9, 31));
    await before.increment(orgA, {
      provider: 'gemini',
      periodKind: 'day',
      periodStart: day,
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      audioSeconds: '1.500',
      costUsd: '0.000100',
    });
    await before.increment(orgA, {
      provider: 'other',
      periodKind: 'day',
      periodStart: day,
      requests: 1,
      costUsd: '0.000200',
    });
    const c = clients.pop()!;
    await c.$disconnect();

    const after = createAiUsageCounterRepository({ client: app() });
    const t = await after.providerTotalsSince(orgA, 'gemini', '2026-10-01');
    expect(t).toEqual({
      requests: 1,
      inputTokens: 10n,
      outputTokens: 5n,
      audioSeconds: '1.500',
      costUsd: '0.000100',
    });
    expect(await after.organizationCostSince(orgA, '2026-10-01')).toBe('0.000300');
    // Cross-org: org B sees nothing of org A.
    expect((await after.providerTotalsSince(orgB, 'gemini', '2026-10-01')).requests).toBe(0);
    expect(await after.organizationCostSince(orgB, '2026-10-01')).toBe('0');
  });

  it('concurrent usage increments do not lose updates', async () => {
    const repo = createAiUsageCounterRepository({ client: app() });
    const day = '2026-10-30';
    await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.increment(orgB, {
          provider: 'gemini',
          periodKind: 'day',
          periodStart: day,
          requests: 1,
          costUsd: '0.000001',
        }),
      ),
    );
    const t = await repo.providerTotalsSince(orgB, 'gemini', day);
    expect(t.requests).toBe(20);
    expect(t.costUsd).toBe('0.000020');
  });

  it('duplicate claims from two "processes" (two pools): exactly one winner', async () => {
    const p1 = createAiIdempotencyRepository({ client: app() });
    const p2 = createAiIdempotencyRepository({ client: app() });
    const key = `summary:${randomUUID()}`;
    const wins = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? p1 : p2).claim(orgA, key, 60_000)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('a stored result survives a restart; release frees a failed claim', async () => {
    const key = `summary:${randomUUID()}`;
    const before = createAiIdempotencyRepository({ client: app() });
    expect(await before.claim(orgA, key, 60_000)).toBe(true);
    await before.storeResult(orgA, key, '{"status":"succeeded"}', 60_000);
    const c = clients.pop()!;
    await c.$disconnect();

    const after = createAiIdempotencyRepository({ client: app() });
    expect(await after.getResult(orgA, key)).toBe('{"status":"succeeded"}');
    expect(await after.claim(orgA, key, 60_000)).toBe(false);

    const failed = `summary:${randomUUID()}`;
    expect(await after.claim(orgA, failed, 60_000)).toBe(true);
    expect(await after.release(orgA, failed)).toBe(true);
    expect(await after.claim(orgA, failed, 60_000)).toBe(true);
  });

  it('expired results can be purged and re-claimed', async () => {
    const repo = createAiIdempotencyRepository({ client: app() });
    const key = `summary:${randomUUID()}`;
    await repo.storeResult(orgA, key, '"x"', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await repo.getResult(orgA, key)).toBeUndefined();
    expect(await repo.claim(orgA, key, 60_000)).toBe(false);
    expect(await repo.purgeExpired(orgA, key)).toBe(true);
    expect(await repo.claim(orgA, key, 60_000)).toBe(true);
  });

  it('idempotency keys are isolated per organization (forced RLS)', async () => {
    const repo = createAiIdempotencyRepository({ client: app() });
    const key = `summary:${randomUUID()}`;
    await repo.storeResult(orgA, key, '"a-only"', 60_000);
    expect(await repo.getResult(orgB, key)).toBeUndefined();
    expect(await repo.release(orgB, key)).toBe(false);
    expect(await repo.purgeExpired(orgB, key)).toBe(false);
    // Org B gets its own independent key; org A's row is untouched.
    expect(await repo.claim(orgB, key, 60_000)).toBe(true);
    expect(await repo.getResult(orgA, key)).toBe('"a-only"');
    // Without org context nothing is visible at all.
    const raw = app();
    expect(await raw.$queryRaw<unknown[]>`SELECT 1 FROM "ai_idempotency"`).toHaveLength(0);
  });

  it('org AI config persists across a restart, upserts in place and is isolated per org', async () => {
    const before = createAiOrgConfigRepository({ client: app() });
    expect(await before.get(orgA)).toBeUndefined();
    await before.upsert(orgA, {
      config: { approvedProviders: ['gemini'], defaults: { llm: { provider: 'gemini' } } },
      monthlyBudgetUsd: '25.00',
      updatedById: null,
    });
    const after = createAiOrgConfigRepository({ client: app() });
    expect(await after.get(orgA)).toEqual({
      config: { approvedProviders: ['gemini'], defaults: { llm: { provider: 'gemini' } } },
      monthlyBudgetUsd: '25.00',
    });
    await after.upsert(orgA, { config: { approvedProviders: [] }, updatedById: null });
    expect(await after.get(orgA)).toEqual({
      config: { approvedProviders: [] },
      monthlyBudgetUsd: undefined,
    });
    // Forced RLS: org B never sees org A's row.
    expect(await after.get(orgB)).toBeUndefined();
  });
});
