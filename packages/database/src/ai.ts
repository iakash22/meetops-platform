import type { Prisma } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

export type AiUsagePeriodKind = 'day' | 'month';
export type AiIdempotencyStatus = 'pending' | 'succeeded' | 'failed';

/** Decimal inputs accept a number or a decimal string (strings avoid float rounding for costs). */
type DecimalInput = number | string;

export interface AiUsageDelta {
  provider: string;
  periodKind: AiUsagePeriodKind;
  /** Bucket start (UTC date). For `month` it must be the first day of the month (CHECK in SQL). */
  periodStart: Date | string;
  requests?: number;
  inputTokens?: number | bigint;
  outputTokens?: number | bigint;
  audioSeconds?: DecimalInput;
  costUsd?: DecimalInput;
}

export interface AiUsageCounterTotals {
  requests: number;
  inputTokens: bigint;
  outputTokens: bigint;
  /** Decimal as string, e.g. "12.500". */
  audioSeconds: string;
  /** Decimal as string, e.g. "0.012345". */
  costUsd: string;
}

const isoDate = (d: Date | string): string =>
  typeof d === 'string' ? d : d.toISOString().slice(0, 10);
const dec = (v: DecimalInput | undefined): string => (v === undefined ? '0' : String(v));
const big = (v: number | bigint | undefined): string =>
  v === undefined ? '0' : BigInt(v).toString();

function runner(options: RepositoryOptions) {
  return <T>(
    organizationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
}

/** AiUsageCounter: atomic increments and cost queries, each in withOrganizationContext. */
export function createAiUsageCounterRepository(options: RepositoryOptions = {}) {
  const run = runner(options);
  return {
    /**
     * Add the deltas for all five counters to the (organization, provider, periodKind, periodStart) bucket
     * in one atomic INSERT ... ON CONFLICT DO UPDATE. Safe under concurrency; returns the new totals.
     */
    increment(organizationId: string, delta: AiUsageDelta): Promise<AiUsageCounterTotals> {
      return run(organizationId, async (tx) => {
        const rows = await tx.$queryRaw<
          {
            requests: number;
            input_tokens: bigint;
            output_tokens: bigint;
            audio_seconds: string;
            cost_usd: string;
          }[]
        >`
          INSERT INTO "ai_usage_counters" AS c
            ("id", "org_id", "provider", "period_kind", "period_start", "requests", "input_tokens",
             "output_tokens", "audio_seconds", "cost_usd", "updated_at")
          VALUES (gen_random_uuid(), ${organizationId}::uuid, ${delta.provider},
                  ${delta.periodKind}::"AiUsagePeriodKind", ${isoDate(delta.periodStart)}::date,
                  ${delta.requests ?? 0}::int, ${big(delta.inputTokens)}::bigint, ${big(delta.outputTokens)}::bigint,
                  ${dec(delta.audioSeconds)}::numeric, ${dec(delta.costUsd)}::numeric, now())
          ON CONFLICT ("org_id", "provider", "period_kind", "period_start") DO UPDATE SET
            "requests" = c."requests" + EXCLUDED."requests",
            "input_tokens" = c."input_tokens" + EXCLUDED."input_tokens",
            "output_tokens" = c."output_tokens" + EXCLUDED."output_tokens",
            "audio_seconds" = c."audio_seconds" + EXCLUDED."audio_seconds",
            "cost_usd" = c."cost_usd" + EXCLUDED."cost_usd",
            "updated_at" = now()
          RETURNING "requests", "input_tokens", "output_tokens",
                    "audio_seconds"::text AS "audio_seconds", "cost_usd"::text AS "cost_usd"`;
        const r = rows[0]!;
        return {
          requests: r.requests,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          audioSeconds: r.audio_seconds,
          costUsd: r.cost_usd,
        };
      });
    },

    /**
     * Sum of costUsd across all providers for buckets starting on or after `since` (UTC date).
     * Sums `day` buckets by default so callers that also keep `month` buckets do not double count.
     * Month-to-date: organizationCostSince(id, firstDayOfMonthUtc). Returns a decimal string.
     */
    organizationCostSince(
      organizationId: string,
      since: Date | string,
      periodKind: AiUsagePeriodKind = 'day',
    ): Promise<string> {
      return run(organizationId, async (tx) => {
        const rows = await tx.$queryRaw<{ total: string }[]>`
          SELECT COALESCE(SUM("cost_usd"), 0)::text AS total FROM "ai_usage_counters"
          WHERE "period_kind" = ${periodKind}::"AiUsagePeriodKind" AND "period_start" >= ${isoDate(since)}::date`;
        return rows[0]?.total ?? '0';
      });
    },
  };
}

/** AiIdempotency: single-winner claims per (organization, key). */
export function createAiIdempotencyRepository(options: RepositoryOptions = {}) {
  const run = runner(options);
  return {
    /**
     * Claim `key` for `ttlMs`. Returns true for exactly one concurrent caller: either the INSERT wins
     * (ON CONFLICT DO NOTHING RETURNING) or, if the key exists, a still-pending claim whose expires_at has
     * passed is re-claimed with a conditional UPDATE (WHERE status = 'pending' AND expires_at < now()).
     * Row locks make the loser re-check the predicate, so two callers never both win.
     */
    claim(organizationId: string, key: string, ttlMs: number): Promise<boolean> {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ttlMs must be > 0');
      return run(organizationId, async (tx) => {
        const secs = ttlMs / 1000;
        const inserted = await tx.$queryRaw<{ key: string }[]>`
          INSERT INTO "ai_idempotency" ("org_id", "key", "status", "created_at", "expires_at")
          VALUES (${organizationId}::uuid, ${key}, 'pending', now(), now() + make_interval(secs => ${secs}::float8))
          ON CONFLICT ("org_id", "key") DO NOTHING
          RETURNING "key"`;
        if (inserted.length === 1) return true;
        const reclaimed = await tx.$queryRaw<{ key: string }[]>`
          UPDATE "ai_idempotency"
          SET "created_at" = now(), "expires_at" = now() + make_interval(secs => ${secs}::float8)
          WHERE "org_id" = ${organizationId}::uuid AND "key" = ${key}
            AND "status" = 'pending' AND "expires_at" < now()
          RETURNING "key"`;
        return reclaimed.length === 1;
      });
    },

    /** Record the outcome of a claimed key. Returns false if the key is not pending. */
    complete(
      organizationId: string,
      key: string,
      status: Exclude<AiIdempotencyStatus, 'pending'>,
      resultRef?: string,
    ): Promise<boolean> {
      return run(organizationId, async (tx) => {
        const n = await tx.$executeRaw`
          UPDATE "ai_idempotency" SET "status" = ${status}::"AiIdempotencyStatus", "result_ref" = ${resultRef ?? null}
          WHERE "org_id" = ${organizationId}::uuid AND "key" = ${key} AND "status" = 'pending'`;
        return n === 1;
      });
    },
  };
}

export type AiUsageCounterRepository = ReturnType<typeof createAiUsageCounterRepository>;
export type AiIdempotencyRepository = ReturnType<typeof createAiIdempotencyRepository>;
