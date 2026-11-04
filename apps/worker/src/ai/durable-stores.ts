import {
  DEFAULT_IDEMPOTENCY_TTL_SEC,
  InMemoryIdempotencyStore,
  InMemoryOrgConfigStore,
  orgAIConfigSchema,
  type OrgAIConfig,
  type OrgConfigStore,
  type OrgConfigWriteMeta,
  InMemoryUsageTracker,
  type IdempotencyStore,
  type UsageRecord,
  type UsageTracker,
} from '@meetops/ai-core';
import {
  createAiIdempotencyRepository,
  createAiOrgConfigRepository,
  type AiOrgConfigRepository,
  createAiUsageCounterRepository,
  type AiIdempotencyRepository,
  type AiUsageCounterRepository,
} from '@meetops/database';

/**
 * Durable AI stores for the worker (Postgres, forced RLS, every call inside withOrganizationContext).
 *
 * Why Postgres for idempotency rather than Redis: `ai_idempotency` already exists (migration
 * 20261024010000) with ENABLE + FORCE RLS and a fail-closed tenant_isolation policy, so org scoping is
 * enforced by the database, not only by key prefixes. It survives restarts regardless of Redis
 * persistence / maxmemory eviction settings (Redis here is the BullMQ broker), and the worker already
 * holds a Postgres connection for the same job. Errors propagate: there is no fallback to memory.
 */

const dayStartUtc = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/** numeric(12,6) column: fixed six decimals, never exponent notation. */
const usd = (n: number) => (Number.isFinite(n) && n > 0 ? n.toFixed(6) : '0');
const nonNeg = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n > 0 ? n : 0);

export class PostgresUsageTracker implements UsageTracker {
  constructor(private readonly repo: AiUsageCounterRepository = createAiUsageCounterRepository()) {}

  async record(rec: UsageRecord): Promise<void> {
    const u = rec.usage;
    let input = nonNeg(u.inputTokens);
    const output = nonNeg(u.outputTokens);
    // Providers that only report a total: count it as input so token quotas still apply.
    if (u.inputTokens === undefined && u.outputTokens === undefined) input = nonNeg(u.totalTokens);
    await this.repo.increment(rec.organizationId, {
      provider: rec.provider,
      periodKind: 'day',
      periodStart: dayStartUtc(new Date(rec.at)),
      requests: 1,
      inputTokens: Math.round(input),
      outputTokens: Math.round(output),
      audioSeconds: nonNeg(u.audioSeconds).toFixed(3),
      costUsd: usd(u.estimatedCostUsd),
    });
  }

  async totals(q: { organizationId: string; provider: string; since: Date }) {
    const t = await this.repo.providerTotalsSince(
      q.organizationId,
      q.provider,
      dayStartUtc(q.since),
    );
    return {
      requests: t.requests,
      tokens: Number(t.inputTokens + t.outputTokens),
      audioSeconds: Number(t.audioSeconds),
      costUsd: Number(t.costUsd),
    };
  }

  async organizationCostSince(organizationId: string, since: Date): Promise<number> {
    return Number(await this.repo.organizationCostSince(organizationId, dayStartUtc(since)));
  }
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly repo: AiIdempotencyRepository = createAiIdempotencyRepository()) {}

  async get<T>(organizationId: string, key: string): Promise<T | undefined> {
    const raw = await this.repo.getResult(organizationId, key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async set<T>(
    organizationId: string,
    key: string,
    value: T,
    ttlSec = DEFAULT_IDEMPOTENCY_TTL_SEC,
  ): Promise<void> {
    await this.repo.storeResult(organizationId, key, JSON.stringify(value), ttlSec * 1000);
  }

  async claim(organizationId: string, key: string, ttlSec: number): Promise<boolean> {
    if (await this.repo.claim(organizationId, key, ttlSec * 1000)) return true;
    // An expired finished row would otherwise block the key forever.
    if (await this.repo.purgeExpired(organizationId, key))
      return this.repo.claim(organizationId, key, ttlSec * 1000);
    return false;
  }

  async release(organizationId: string, key: string): Promise<void> {
    await this.repo.release(organizationId, key);
  }
}

/**
 * Durable OrgConfigStore (ADR-009 open item) on `ai_org_config` (migration 20261024010000, forced RLS,
 * one row per organization). `monthlyBudgetUsd` lives in its own numeric column; the rest of the
 * OrgAIConfig (minus organizationId, which is the row key) is the `config` JSON object. Stored rows are
 * re-validated with orgAIConfigSchema on read, so a malformed row fails the job instead of silently
 * routing somewhere else. Errors propagate: there is no fallback to memory.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresOrgConfigStore implements OrgConfigStore {
  constructor(private readonly repo: AiOrgConfigRepository = createAiOrgConfigRepository()) {}

  async get(organizationId: string): Promise<OrgAIConfig | undefined> {
    const row = await this.repo.get(organizationId);
    if (!row) return undefined;
    const parsed = orgAIConfigSchema.safeParse({
      ...row.config,
      organizationId,
      ...(row.monthlyBudgetUsd !== undefined
        ? { monthlyBudgetUsd: Number(row.monthlyBudgetUsd) }
        : {}),
    });
    // Issue paths only: never echo stored values.
    if (!parsed.success)
      throw new Error(
        `stored AI org config is invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    return parsed.data;
  }

  /**
   * `monthlyBudgetUsd` goes to a numeric(12,2) column: it is rounded to whole cents with
   * `Number.prototype.toFixed(2)` (round half away from zero on the binary double, so e.g. 1.005 can
   * become "1.00"). Values of 10^10 USD or more overflow the column and the write fails.
   * `updatedById` is the acting user when it is a user uuid; system actors are stored as null.
   */
  async put(cfg: OrgAIConfig, meta: OrgConfigWriteMeta = {}): Promise<void> {
    const { organizationId, monthlyBudgetUsd, ...rest } = orgAIConfigSchema.parse(cfg);
    const actor = meta.updatedById;
    await this.repo.upsert(organizationId, {
      config: JSON.parse(JSON.stringify(rest)) as Parameters<
        AiOrgConfigRepository['upsert']
      >[1]['config'],
      monthlyBudgetUsd: monthlyBudgetUsd === undefined ? undefined : monthlyBudgetUsd.toFixed(2),
      updatedById: actor !== undefined && UUID_RE.test(actor) ? actor : null,
    });
  }
}

export type AiStoreMode = 'durable' | 'memory';

/**
 * Select the AI usage, idempotency and org config stores. `AI_STORES=durable` (default) uses Postgres.
 * `AI_STORES=memory` is for unit tests only: it is refused unless NODE_ENV=test, and it is
 * never chosen implicitly (an unknown value is an error, not a fallback).
 */
export function createAiStores(env: Record<string, string | undefined>): {
  mode: AiStoreMode;
  usage: UsageTracker;
  idempotency: IdempotencyStore;
  orgConfig: OrgConfigStore;
} {
  const raw = (env.AI_STORES ?? 'durable').trim();
  if (raw !== 'durable' && raw !== 'memory')
    throw new Error('AI_STORES must be "durable" or "memory"');
  if (raw === 'memory') {
    // Allow-list, not deny-list: staging, production, any other value and an unset NODE_ENV all refuse.
    if (env.NODE_ENV !== 'test')
      throw new Error('AI_STORES=memory is only allowed when NODE_ENV=test');
    return {
      mode: 'memory',
      usage: new InMemoryUsageTracker(),
      idempotency: new InMemoryIdempotencyStore(),
      orgConfig: new InMemoryOrgConfigStore(),
    };
  }
  return {
    mode: 'durable',
    usage: new PostgresUsageTracker(),
    idempotency: new PostgresIdempotencyStore(),
    orgConfig: new PostgresOrgConfigStore(),
  };
}
