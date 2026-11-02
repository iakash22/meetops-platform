import type { AIUsage } from './types.js';
import type { ProviderConfig } from './config.js';

export type UsageRecord = {
  organizationId: string;
  provider: string;
  model: string;
  feature: string;
  usage: AIUsage;
  at: string;
  jobId?: string | undefined;
};

/** Persistence interface for usage; Backend/DB implements a durable version. */
export interface UsageTracker {
  record(rec: UsageRecord): Promise<void>;
  totals(q: {
    organizationId: string;
    provider: string;
    since: Date;
  }): Promise<{ requests: number; tokens: number; audioSeconds: number; costUsd: number }>;
  /** Total estimated spend for an organization across all providers since a date (for per-org budgets). */
  organizationCostSince(organizationId: string, since: Date): Promise<number>;
}

export type QuotaDecision = { allowed: true } | { allowed: false; reason: string };

export interface QuotaManager {
  check(q: {
    organizationId: string;
    provider: ProviderConfig;
    monthlyBudgetUsd?: number | undefined;
  }): Promise<QuotaDecision>;
}

/** Unit tests only. Hosts must select it explicitly (see the worker's AI_STORES); never in production. */
export class InMemoryUsageTracker implements UsageTracker {
  readonly records: UsageRecord[] = [];
  async record(rec: UsageRecord) {
    this.records.push(rec);
  }
  async organizationCostSince(organizationId: string, since: Date) {
    return this.records
      .filter((r) => r.organizationId === organizationId && new Date(r.at) >= since)
      .reduce((s, r) => s + r.usage.estimatedCostUsd, 0);
  }
  async totals(q: { organizationId: string; provider: string; since: Date }) {
    const rs = this.records.filter(
      (r) =>
        r.organizationId === q.organizationId &&
        r.provider === q.provider &&
        new Date(r.at) >= q.since,
    );
    return {
      requests: rs.length,
      tokens: rs.reduce((s, r) => s + (r.usage.totalTokens ?? 0), 0),
      audioSeconds: rs.reduce((s, r) => s + (r.usage.audioSeconds ?? 0), 0),
      costUsd: rs.reduce((s, r) => s + r.usage.estimatedCostUsd, 0),
    };
  }
}

/** Enforces ProviderConfig.usage limits from a UsageTracker. */
export class UsageQuotaManager implements QuotaManager {
  constructor(
    private readonly tracker: UsageTracker,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async check({
    organizationId,
    provider,
    monthlyBudgetUsd,
  }: {
    organizationId: string;
    provider: ProviderConfig;
    monthlyBudgetUsd?: number | undefined;
  }): Promise<QuotaDecision> {
    const now = this.now();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (
      monthlyBudgetUsd !== undefined &&
      (provider.cost.tier === 'paid' || provider.platformBilled)
    ) {
      const spent = await this.tracker.organizationCostSince(organizationId, month);
      if (spent >= monthlyBudgetUsd)
        return { allowed: false, reason: `org monthly budget $${monthlyBudgetUsd} reached` };
    }
    const d = await this.tracker.totals({ organizationId, provider: provider.name, since: day });
    const u = provider.usage;
    if (u.dailyRequestLimit !== undefined && d.requests >= u.dailyRequestLimit)
      return { allowed: false, reason: `daily request limit ${u.dailyRequestLimit} reached` };
    if (u.dailyTokenLimit !== undefined && d.tokens >= u.dailyTokenLimit)
      return { allowed: false, reason: `daily token limit ${u.dailyTokenLimit} reached` };
    if (u.monthlyAudioSecondsLimit !== undefined) {
      const m = await this.tracker.totals({
        organizationId,
        provider: provider.name,
        since: month,
      });
      if (m.audioSeconds >= u.monthlyAudioSecondsLimit)
        return {
          allowed: false,
          reason: `monthly audio limit ${u.monthlyAudioSecondsLimit}s reached`,
        };
    }
    return { allowed: true };
  }
}

export function estimateCost(cfg: ProviderConfig, u: Omit<AIUsage, 'estimatedCostUsd'>): number {
  if (cfg.cost.tier === 'free') return 0;
  const c = cfg.cost;
  return (
    ((u.inputTokens ?? 0) / 1e6) * (c.inputPer1MTokens ?? 0) +
    ((u.outputTokens ?? 0) / 1e6) * (c.outputPer1MTokens ?? 0) +
    ((u.audioSeconds ?? 0) / 3600) * (c.perAudioHour ?? 0)
  );
}

/**
 * Idempotency store: a repeated request with the same key returns the stored result, no new AI call.
 * Keys are always scoped by organization: implementations must never let one organization read or
 * claim another organization's key. Durable implementations live with the host (the worker uses
 * Postgres `ai_idempotency` under forced RLS); errors must propagate (fail closed), never fall back.
 */
export interface IdempotencyStore {
  get<T>(organizationId: string, key: string): Promise<T | undefined>;
  set<T>(organizationId: string, key: string, value: T, ttlSec?: number): Promise<void>;
  /**
   * Single-winner claim across processes. Returns true for exactly one caller until the key is
   * released or the claim expires. Optional: stores without it only dedupe within one process.
   */
  claim?(organizationId: string, key: string, ttlSec: number): Promise<boolean>;
  /** Drop a pending claim (the job did not succeed) so a retry can claim it again. */
  release?(organizationId: string, key: string): Promise<void>;
}

/** Default idempotency TTL (24h) for stored results; claims use the executor's claim TTL. */
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 24 * 60 * 60;

/** Unit tests only. Hosts must select it explicitly (see the worker's AI_STORES); never in production. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly m = new Map<string, { value?: unknown; pending: boolean; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  private k(organizationId: string, key: string) {
    return `${organizationId}\u0000${key}`;
  }
  async get<T>(organizationId: string, key: string) {
    const e = this.m.get(this.k(organizationId, key));
    if (!e || e.pending || e.expiresAt <= this.now()) return undefined;
    return e.value as T;
  }
  async set<T>(
    organizationId: string,
    key: string,
    value: T,
    ttlSec = DEFAULT_IDEMPOTENCY_TTL_SEC,
  ) {
    this.m.set(this.k(organizationId, key), {
      value,
      pending: false,
      expiresAt: this.now() + ttlSec * 1000,
    });
  }
  async claim(organizationId: string, key: string, ttlSec: number) {
    const k = this.k(organizationId, key);
    const e = this.m.get(k);
    if (e && e.expiresAt > this.now()) return false;
    this.m.set(k, { pending: true, expiresAt: this.now() + ttlSec * 1000 });
    return true;
  }
  async release(organizationId: string, key: string) {
    const k = this.k(organizationId, key);
    if (this.m.get(k)?.pending) this.m.delete(k);
  }
}
