import type { ProviderRegistry } from './registry.js';
import type { ModelRouter, AIFeature, RequestOverride, ResolvedRoute } from './router.js';
import type { ProviderConfig } from './config.js';
import { AIError, toAIError } from './errors.js';
import { withRetry, withTimeout, type Sleeper } from './retry.js';
import { estimateCost, type IdempotencyStore, type QuotaManager, type UsageTracker } from './usage.js';
import type { AIResultMeta, AIUsage, AnyProvider } from './types.js';

export type JobStatus = 'succeeded' | 'waiting' | 'retryable' | 'failed';

export type AttemptError = { provider: string; code: AIError['code']; message: string };

export type JobOutcome<T> =
  | { status: 'succeeded'; value: T; meta: AIResultMeta; attempts: AttemptError[] }
  | {
      status: Exclude<JobStatus, 'succeeded'>;
      errors: AttemptError[];
      /** The original request is returned untouched so the caller can persist/re-queue it (no data loss). */
      request: AIJobRequest;
    };

export type AIJobRequest = {
  tenantId: string;
  feature: AIFeature;
  promptVersion: string;
  idempotencyKey?: string | undefined;
  transcriptRevision?: number | undefined;
  override?: RequestOverride | undefined;
  jobId?: string | undefined;
};

export type ProviderCall<T> = (
  provider: AnyProvider,
  ctx: { model: string; config: ProviderConfig; signal: AbortSignal },
) => Promise<{ value: T; usage: Omit<AIUsage, 'estimatedCostUsd'> }>;

export type NotifyHook = (e: { tenantId: string; feature: AIFeature; status: JobStatus; errors: AttemptError[]; jobId?: string | undefined }) => Promise<void> | void;

export type ExecutorDeps = {
  registry: ProviderRegistry;
  router: ModelRouter;
  usage: UsageTracker;
  quota: QuotaManager;
  idempotency: IdempotencyStore;
  notify?: NotifyHook | undefined;
  sleep?: Sleeper | undefined;
  now?: (() => Date) | undefined;
};

/** Build ordered candidate list with all policy checks applied. Exported for tests/explainability. */
export function planCandidates(route: ResolvedRoute, registry: ProviderRegistry): { candidates: ProviderConfig[]; skipped: AttemptError[] } {
  const skipped: AttemptError[] = [];
  const primary = registry.getConfig(route.provider);
  const primaryPaid = primary?.cost.tier === 'paid';
  const platformDefault = route.source === 'system' || route.source === 'env';

  const ordered = [route.provider, ...route.fallbacks];
  // Implicit fallbacks: enabled *local* providers with the capability (free, self-hosted), by priority.
  const locals = registry
    .list()
    .filter((c) => c.local && c.enabled && c.type === route.kind && c.capabilities.includes(route.capability))
    .sort((a, b) => a.fallbackPriority - b.fallbackPriority)
    .map((c) => c.name);
  for (const n of locals) if (!ordered.includes(n)) ordered.push(n);

  const candidates: ProviderConfig[] = [];
  ordered.forEach((name, i) => {
    const cfg = registry.getConfig(name);
    const skip = (code: AIError['code'], message: string) => skipped.push({ provider: name, code, message });
    if (!cfg) return skip('PROVIDER_UNAVAILABLE', 'unknown provider');
    if (cfg.type !== route.kind) return skip('CAPABILITY_UNSUPPORTED', `provider is ${cfg.type}, feature needs ${route.kind}`);
    if (!cfg.capabilities.includes(route.capability)) return skip('CAPABILITY_UNSUPPORTED', `missing capability ${route.capability}`);
    const av = registry.availability(name);
    if (!av.available) return skip(cfg.enabled ? 'MISSING_CREDENTIALS' : 'PROVIDER_DISABLED', av.reason ?? 'unavailable');
    const isPrimary = i === 0;
    const implicitlyApproved = (isPrimary && platformDefault) || cfg.local;
    if (route.requireApproval && !implicitlyApproved && !route.approvedProviders.includes(name))
      return skip('UNAUTHORIZED_OVERRIDE', 'provider not approved for this organization');
    // Never auto free->paid. Even with AI_ALLOW_PAID_FALLBACK=true, a paid fallback must be explicitly configured.
    const explicitFallback = route.fallbacks.includes(name);
    if (!isPrimary && cfg.cost.tier === 'paid' && !primaryPaid && !(route.allowPaidFallback && explicitFallback))
      return skip('PAID_FALLBACK_BLOCKED', 'free -> paid fallback disabled (AI_ALLOW_PAID_FALLBACK=false)');
    candidates.push(cfg);
  });
  return { candidates, skipped };
}

export class AIExecutor {
  private readonly inflight = new Map<string, Promise<JobOutcome<unknown>>>();
  constructor(private readonly deps: ExecutorDeps) {}

  async run<T>(req: AIJobRequest, call: ProviderCall<T>): Promise<JobOutcome<T>> {
    const key = req.idempotencyKey ? `${req.tenantId}:${req.feature}:${req.idempotencyKey}` : undefined;
    if (key) {
      const stored = await this.deps.idempotency.get<JobOutcome<T>>(key);
      if (stored && stored.status === 'succeeded') return { ...stored, meta: { ...stored.meta, cached: true } };
      const pending = this.inflight.get(key);
      if (pending) return pending as Promise<JobOutcome<T>>;
    }
    const p = this.execute(req, call);
    if (key) this.inflight.set(key, p);
    try {
      const out = await p;
      if (key && out.status === 'succeeded') await this.deps.idempotency.set(key, out);
      return out;
    } finally {
      if (key) this.inflight.delete(key);
    }
  }

  private async execute<T>(req: AIJobRequest, call: ProviderCall<T>): Promise<JobOutcome<T>> {
    const errors: AttemptError[] = [];
    let route: ResolvedRoute;
    try {
      route = await this.deps.router.resolve(req.tenantId, req.feature, req.override);
    } catch (e) {
      const err = toAIError(e);
      errors.push({ provider: '-', code: err.code, message: err.message });
      return this.finish(req, 'failed', errors);
    }
    const plan = planCandidates(route, this.deps.registry);
    errors.push(...plan.skipped);

    for (const cfg of plan.candidates) {
      const q = await this.deps.quota.check({ tenantId: req.tenantId, provider: cfg, monthlyBudgetUsd: route.monthlyBudgetUsd });
      if (!q.allowed) {
        errors.push({ provider: cfg.name, code: 'QUOTA_EXCEEDED', message: q.reason });
        continue;
      }
      const model = cfg.name === route.provider && route.model ? route.model : cfg.model;
      try {
        const provider = this.deps.registry.get(cfg.name);
        const res = await withRetry(
          () => withTimeout((signal) => call(provider, { model, config: cfg, signal }), cfg.timeoutMs, cfg.name),
          cfg.retryPolicy,
          { provider: cfg.name, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) },
        );
        const usage: AIUsage = { ...res.usage, estimatedCostUsd: estimateCost(cfg, res.usage) };
        await this.deps.usage.record({
          tenantId: req.tenantId,
          provider: cfg.name,
          model,
          feature: req.feature,
          usage,
          at: (this.deps.now?.() ?? new Date()).toISOString(),
          jobId: req.jobId,
        });
        const meta: AIResultMeta = {
          provider: cfg.name,
          model,
          promptVersion: req.promptVersion,
          usage,
          transcriptRevision: req.transcriptRevision,
          idempotencyKey: req.idempotencyKey,
        };
        return { status: 'succeeded', value: res.value, meta, attempts: errors };
      } catch (e) {
        const err = toAIError(e, cfg.name);
        errors.push({ provider: cfg.name, code: err.code, message: err.message });
        if (err.code === 'QUOTA_EXCEEDED' || err.code === 'RATE_LIMITED') this.deps.registry.markHealth(cfg.name, 'degraded', err.code);
      }
    }
    const codes = errors.map((e) => e.code);
    const tried = errors.filter((e) => plan.candidates.some((c) => c.name === e.provider));
    const status: JobOutcome<T>['status'] =
      tried.length > 0 && tried.every((e) => e.code === 'QUOTA_EXCEEDED' || e.code === 'RATE_LIMITED')
        ? 'waiting'
        : tried.some((e) => ['TIMEOUT', 'PROVIDER_UNAVAILABLE', 'MODEL_ERROR', 'RATE_LIMITED'].includes(e.code))
          ? 'retryable'
          : codes.includes('QUOTA_EXCEEDED')
            ? 'waiting'
            : 'failed';
    return this.finish(req, status, errors);
  }

  private async finish<T>(req: AIJobRequest, status: Exclude<JobStatus, 'succeeded'>, errors: AttemptError[]): Promise<JobOutcome<T>> {
    await this.deps.notify?.({ tenantId: req.tenantId, feature: req.feature, status, errors, jobId: req.jobId });
    return { status, errors, request: req };
  }
}
