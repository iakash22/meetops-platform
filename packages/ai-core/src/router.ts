import { z } from 'zod';
import type { AIEnv } from './env.js';
import type { Capability } from './types.js';
import { AIError } from './errors.js';
import type { AuditSink } from './audit.js';

export const AI_FEATURES = [
  'transcription',
  'live-transcription',
  'summary',
  'agenda',
  'decisions',
  'highlights',
  'actions',
  'employee-suggestions',
  'deadlines',
  'reports',
  'follow-ups',
] as const;
export const aiFeatureSchema = z.enum(AI_FEATURES);
export type AIFeature = (typeof AI_FEATURES)[number];

export const FEATURE_CAPABILITY: Record<AIFeature, Capability> = {
  transcription: 'batch-transcription',
  'live-transcription': 'streaming-transcription',
  summary: 'structured-output',
  agenda: 'structured-output',
  decisions: 'structured-output',
  highlights: 'structured-output',
  actions: 'structured-output',
  'employee-suggestions': 'structured-output',
  deadlines: 'structured-output',
  reports: 'text-generation',
  'follow-ups': 'text-generation',
};
export const featureKind = (f: AIFeature): 'llm' | 'stt' => (f === 'transcription' || f === 'live-transcription' ? 'stt' : 'llm');

export const routeSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  /** Ordered, explicitly authorized fallbacks for this layer. */
  fallbacks: z.array(z.string().min(1)).max(5).optional(),
});
export type RouteSelection = z.infer<typeof routeSelectionSchema>;

export const orgAIConfigSchema = z.object({
  tenantId: z.string().min(1),
  /** Default per kind for this org. */
  defaults: z.object({ llm: routeSelectionSchema.optional(), stt: routeSelectionSchema.optional() }).default({}),
  /** Per feature/workflow overrides. */
  features: z.partialRecord(aiFeatureSchema, routeSelectionSchema).default({}),
  /** Providers an org admin has approved (required when AI_REQUIRE_PROVIDER_APPROVAL=true). */
  approvedProviders: z.array(z.string()).default([]),
  allowPaidFallback: z.boolean().optional(),
  /** Per-org monthly spend cap (USD) on paid providers, enforced before each call. */
  monthlyBudgetUsd: z.number().min(0).optional(),
});
export type OrgAIConfig = z.infer<typeof orgAIConfigSchema>;
export type OrgAIConfigInput = z.input<typeof orgAIConfigSchema>;

/** Persistence for tenant AI config. Backend/DB supplies a durable, tenant-scoped implementation. */
export interface OrgConfigStore {
  get(tenantId: string): Promise<OrgAIConfig | undefined>;
  put(cfg: OrgAIConfig): Promise<void>;
}

export class InMemoryOrgConfigStore implements OrgConfigStore {
  private readonly m = new Map<string, OrgAIConfig>();
  async get(tenantId: string) {
    const c = this.m.get(tenantId);
    return c ? structuredClone(c) : undefined;
  }
  async put(cfg: OrgAIConfig) {
    this.m.set(cfg.tenantId, structuredClone(cfg));
  }
}

export type RequestOverride = RouteSelection & {
  /** Caller must have been authorized upstream (e.g. org admin / feature flag). */
  authorized: boolean;
};

export type ResolutionSource = 'system' | 'env' | 'organization' | 'feature' | 'request';

export type ResolvedRoute = {
  tenantId: string;
  feature: AIFeature;
  kind: 'llm' | 'stt';
  capability: Capability;
  provider: string;
  model: string | undefined;
  source: ResolutionSource;
  fallbacks: string[];
  requireApproval: boolean;
  approvedProviders: string[];
  allowPaidFallback: boolean;
  monthlyBudgetUsd: number | undefined;
  trace: Array<{ source: ResolutionSource; selection?: RouteSelection | undefined }>;
};

export const SYSTEM_DEFAULTS: Record<'llm' | 'stt', RouteSelection> = {
  llm: { provider: 'gemini', model: 'gemini-2.5-flash-lite' },
  stt: { provider: 'assemblyai' },
};

export class ModelRouter {
  constructor(
    private readonly env: AIEnv,
    private readonly orgStore: OrgConfigStore,
    private readonly audit?: AuditSink,
  ) {}

  envSelection(kind: 'llm' | 'stt'): RouteSelection {
    if (kind === 'llm') {
      const p = this.env.AI_LLM_PROVIDER;
      const model = p === 'gemini' ? this.env.GEMINI_MODEL : p === 'ollama' ? this.env.OLLAMA_MODEL : this.env.OPENAI_MODEL;
      return { provider: p, model };
    }
    const p = this.env.AI_STT_PROVIDER;
    return p === 'faster-whisper' ? { provider: p, model: this.env.LOCAL_STT_MODEL } : { provider: p };
  }

  async setOrgConfig(input: OrgAIConfigInput, actorId: string) {
    const cfg = orgAIConfigSchema.parse(input);
    const before = await this.orgStore.get(cfg.tenantId);
    await this.orgStore.put(cfg);
    await this.audit?.emit({ action: before ? 'update' : 'create', tenantId: cfg.tenantId, actorId, before, after: cfg, at: new Date().toISOString() });
  }

  /**
   * Precedence (lowest -> highest): system default < env < organization < feature/workflow < authorized request.
   * The highest layer that specifies a provider wins; its model is used, else the provider default (undefined).
   */
  async resolve(tenantId: string, feature: AIFeature, override?: RequestOverride): Promise<ResolvedRoute> {
    if (!tenantId) throw new AIError('CONFIG_INVALID', 'tenantId is required');
    const kind = featureKind(feature);
    const org = await this.orgStore.get(tenantId);
    if (org && org.tenantId !== tenantId) throw new AIError('CONFIG_INVALID', 'tenant mismatch in org config store');
    if (override && !override.authorized)
      throw new AIError('UNAUTHORIZED_OVERRIDE', 'Per-request provider override is not authorized', { retryable: false });

    const layers: Array<[ResolutionSource, RouteSelection | undefined]> = [
      ['system', SYSTEM_DEFAULTS[kind]],
      ['env', this.envSelection(kind)],
      ['organization', org?.defaults[kind]],
      ['feature', org?.features[feature]],
      ['request', override ? { provider: override.provider, model: override.model, fallbacks: override.fallbacks } : undefined],
    ];
    let chosen: [ResolutionSource, RouteSelection] = ['system', SYSTEM_DEFAULTS[kind]];
    for (const [src, sel] of layers) if (sel) chosen = [src, sel];
    const [source, sel] = chosen;
    const fallbacks = sel.fallbacks ?? (source === 'request' ? (org?.features[feature]?.fallbacks ?? org?.defaults[kind]?.fallbacks) : undefined) ?? [];
    if (override) await this.audit?.emit({ action: 'override', tenantId, actorId: 'request', feature, after: override, at: new Date().toISOString() });
    return {
      tenantId,
      feature,
      kind,
      capability: FEATURE_CAPABILITY[feature],
      provider: sel.provider,
      model: sel.model,
      source,
      fallbacks,
      requireApproval: this.env.AI_REQUIRE_PROVIDER_APPROVAL,
      approvedProviders: org?.approvedProviders ?? [],
      allowPaidFallback: this.env.AI_ALLOW_PAID_FALLBACK && (org?.allowPaidFallback ?? true),
      monthlyBudgetUsd: org?.monthlyBudgetUsd,
      trace: layers.map(([s, x]) => ({ source: s, selection: x })),
    };
  }
}
