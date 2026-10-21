import type { AIUsage } from './types.js';
import type { ProviderConfig } from './config.js';

export type UsageRecord = {
  tenantId: string;
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
  totals(q: { tenantId: string; provider: string; since: Date }): Promise<{ requests: number; tokens: number; audioSeconds: number; costUsd: number }>;
  /** Total estimated spend for a tenant across all providers since a date (for per-org budgets). */
  tenantCostSince(tenantId: string, since: Date): Promise<number>;
}

export type QuotaDecision = { allowed: true } | { allowed: false; reason: string };

export interface QuotaManager {
  check(q: { tenantId: string; provider: ProviderConfig; monthlyBudgetUsd?: number | undefined }): Promise<QuotaDecision>;
}

export class InMemoryUsageTracker implements UsageTracker {
  readonly records: UsageRecord[] = [];
  async record(rec: UsageRecord) {
    this.records.push(rec);
  }
  async tenantCostSince(tenantId: string, since: Date) {
    return this.records.filter((r) => r.tenantId === tenantId && new Date(r.at) >= since).reduce((s, r) => s + r.usage.estimatedCostUsd, 0);
  }
  async totals(q: { tenantId: string; provider: string; since: Date }) {
    const rs = this.records.filter((r) => r.tenantId === q.tenantId && r.provider === q.provider && new Date(r.at) >= q.since);
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
  constructor(private readonly tracker: UsageTracker, private readonly now: () => Date = () => new Date()) {}
  async check({ tenantId, provider, monthlyBudgetUsd }: { tenantId: string; provider: ProviderConfig; monthlyBudgetUsd?: number | undefined }): Promise<QuotaDecision> {
    const now = this.now();
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (monthlyBudgetUsd !== undefined && provider.cost.tier === 'paid') {
      const spent = await this.tracker.tenantCostSince(tenantId, month);
      if (spent >= monthlyBudgetUsd) return { allowed: false, reason: `org monthly budget $${monthlyBudgetUsd} reached` };
    }
    const d = await this.tracker.totals({ tenantId, provider: provider.name, since: day });
    const u = provider.usage;
    if (u.dailyRequestLimit !== undefined && d.requests >= u.dailyRequestLimit)
      return { allowed: false, reason: `daily request limit ${u.dailyRequestLimit} reached` };
    if (u.dailyTokenLimit !== undefined && d.tokens >= u.dailyTokenLimit)
      return { allowed: false, reason: `daily token limit ${u.dailyTokenLimit} reached` };
    if (u.monthlyAudioSecondsLimit !== undefined) {
      const m = await this.tracker.totals({ tenantId, provider: provider.name, since: month });
      if (m.audioSeconds >= u.monthlyAudioSecondsLimit)
        return { allowed: false, reason: `monthly audio limit ${u.monthlyAudioSecondsLimit}s reached` };
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

/** Idempotency store: a repeated request with the same key returns the stored result, no new AI call. */
export interface IdempotencyStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSec?: number): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly m = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.m.set(key, value);
  }
}
