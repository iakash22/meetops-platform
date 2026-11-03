import { z } from 'zod';
import { isOrgSecretRefShape, parseOrgSecretRef } from './credential-ref.js';
import type { AIEnv } from './env.js';
import type { Capability } from './types.js';
import { AIError } from './errors.js';
import { redact, type AuditSink } from './audit.js';
import { assertCan, type TenantContext } from './auth.js';

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
  /** Phase 7 semantic search. No default provider declares the capability, so it is unconfigured until routed. */
  'embeddings',
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
  embeddings: 'embeddings',
};
export type RouteKind = 'llm' | 'stt' | 'embeddings';
/**
 * Embeddings are their own kind: they never inherit the org/env/system chat-model (`llm`) route, so text is only
 * embedded by an explicitly routed embeddings provider/model (org `defaults.embeddings` or `features.embeddings`).
 */
export const featureKind = (f: AIFeature): RouteKind =>
  f === 'embeddings'
    ? 'embeddings'
    : f === 'transcription' || f === 'live-transcription'
      ? 'stt'
      : 'llm';

export const routeSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  /** Ordered, explicitly authorized fallbacks for this layer. */
  fallbacks: z.array(z.string().min(1)).max(5).optional(),
});
export type RouteSelection = z.infer<typeof routeSelectionSchema>;

export const orgAIConfigSchema = z.object({
  organizationId: z.string().min(1),
  /** Default per kind for this org. */
  defaults: z
    .object({
      llm: routeSelectionSchema.optional(),
      stt: routeSelectionSchema.optional(),
      embeddings: routeSelectionSchema.optional(),
    })
    .default({}),
  /** Per feature/workflow overrides. */
  features: z.partialRecord(aiFeatureSchema, routeSelectionSchema).default({}),
  /** Providers an org admin has approved (required when AI_REQUIRE_PROVIDER_APPROVAL=true). */
  approvedProviders: z.array(z.string()).default([]),
  allowPaidFallback: z.boolean().optional(),
  /** Per-org monthly spend cap (USD) on paid or platform-billed providers, enforced before each call. */
  monthlyBudgetUsd: z.number().min(0).optional(),
  /** BYO credential refs per provider. Must be `secret:org/<organizationId>/...` (checked in setOrgConfig + at resolve time). */
  credentialRefs: z
    .record(
      z.string(),
      z.string().refine(isOrgSecretRefShape, 'must be secret:org/<organizationId>/<name>'),
    )
    .default({}),
});
export type OrgAIConfig = z.infer<typeof orgAIConfigSchema>;
export type OrgAIConfigInput = z.input<typeof orgAIConfigSchema>;

/** Persistence for organization AI config. Backend/DB supplies a durable, organization-scoped implementation. */
export interface OrgConfigStore {
  get(organizationId: string): Promise<OrgAIConfig | undefined>;
  put(cfg: OrgAIConfig, meta?: OrgConfigWriteMeta): Promise<void>;
}

/** Who wrote the config (the acting user id from the TenantContext); stores may persist it. */
export type OrgConfigWriteMeta = { updatedById?: string | undefined };

export class InMemoryOrgConfigStore implements OrgConfigStore {
  private readonly m = new Map<string, OrgAIConfig>();
  async get(organizationId: string) {
    const c = this.m.get(organizationId);
    return c ? structuredClone(c) : undefined;
  }
  async put(cfg: OrgAIConfig) {
    this.m.set(cfg.organizationId, structuredClone(cfg));
  }
}

/** Per-request override. Authorization is derived server-side from the actor's ability, never from this payload. */
export type RequestOverride = RouteSelection;

export type ResolutionSource = 'system' | 'env' | 'organization' | 'feature' | 'request';

export type ResolvedRoute = {
  organizationId: string;
  feature: AIFeature;
  /** Provider type the feature runs on (embeddings run on `llm` providers, but are routed separately). */
  kind: 'llm' | 'stt';
  /** Which route defaults apply (`embeddings` never falls back to the llm defaults). */
  routeKind: RouteKind;
  capability: Capability;
  provider: string;
  model: string | undefined;
  source: ResolutionSource;
  fallbacks: string[];
  requireApproval: boolean;
  approvedProviders: string[];
  allowPaidFallback: boolean;
  monthlyBudgetUsd: number | undefined;
  credentialRefs: Record<string, string>;
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
    private readonly audit: AuditSink,
  ) {
    if (!audit) throw new AIError('CONFIG_INVALID', 'AuditSink is required');
  }

  envSelection(kind: 'llm' | 'stt'): RouteSelection;
  envSelection(kind: RouteKind): RouteSelection | undefined;
  envSelection(kind: RouteKind): RouteSelection | undefined {
    if (kind === 'embeddings') return undefined;
    if (kind === 'llm') {
      const p = this.env.AI_LLM_PROVIDER;
      const model =
        p === 'gemini'
          ? this.env.GEMINI_MODEL
          : p === 'ollama'
            ? this.env.OLLAMA_MODEL
            : this.env.OPENAI_MODEL;
      return { provider: p, model };
    }
    const p = this.env.AI_STT_PROVIDER;
    return p === 'faster-whisper'
      ? { provider: p, model: this.env.LOCAL_STT_MODEL }
      : { provider: p };
  }

  /** Org owner/admin only (CASL `manage ProviderConfig`), same organization only. Audit is awaited; failure aborts the change. */
  async setOrgConfig(input: OrgAIConfigInput, ctx: TenantContext) {
    assertCan(ctx, 'manage', 'ProviderConfig');
    const cfg = orgAIConfigSchema.parse(input);
    if (cfg.organizationId !== ctx.organizationId)
      throw new AIError('FORBIDDEN', "cannot change another organization's AI config", {
        retryable: false,
      });
    for (const ref of Object.values(cfg.credentialRefs))
      if (!parseOrgSecretRef(ref, cfg.organizationId))
        throw new AIError('FORBIDDEN', 'credential ref must belong to this organization', {
          retryable: false,
        });
    const before = await this.orgStore.get(cfg.organizationId);
    try {
      await this.audit.emit({
        action: before ? 'update' : 'create',
        organizationId: cfg.organizationId,
        actorId: ctx.userId,
        before: before ? redact(before) : undefined,
        after: redact(cfg),
        at: new Date().toISOString(),
      });
    } catch (e) {
      throw new AIError('AUDIT_FAILED', 'audit write failed; change aborted', {
        retryable: true,
        cause: e,
      });
    }
    await this.orgStore.put(cfg, { updatedById: ctx.userId });
  }

  /**
   * Precedence (lowest -> highest): system default < env < organization < feature/workflow < authorized request.
   * The highest layer that specifies a provider wins; its model is used, else the provider default (undefined).
   */
  async resolve(
    organizationId: string,
    feature: AIFeature,
    override?: RequestOverride,
    actor?: TenantContext,
  ): Promise<ResolvedRoute> {
    if (!organizationId) throw new AIError('CONFIG_INVALID', 'organizationId is required');
    const kind = featureKind(feature);
    const org = await this.orgStore.get(organizationId);
    if (org && org.organizationId !== organizationId)
      throw new AIError('CONFIG_INVALID', 'organization mismatch in org config store');
    if (
      override &&
      !(
        actor &&
        actor.organizationId === organizationId &&
        actor.ability?.can('override', 'AIRoute')
      )
    )
      throw new AIError(
        'UNAUTHORIZED_OVERRIDE',
        'Per-request provider override is not authorized',
        { retryable: false },
      );

    const layers: Array<[ResolutionSource, RouteSelection | undefined]> = [
      ['system', kind === 'embeddings' ? undefined : SYSTEM_DEFAULTS[kind]],
      ['env', this.envSelection(kind)],
      ['organization', org?.defaults[kind]],
      ['feature', org?.features[feature]],
      [
        'request',
        override
          ? { provider: override.provider, model: override.model, fallbacks: override.fallbacks }
          : undefined,
      ],
    ];
    let chosen: [ResolutionSource, RouteSelection] | undefined =
      kind === 'embeddings' ? undefined : ['system', SYSTEM_DEFAULTS[kind]];
    for (const [src, sel] of layers) if (sel) chosen = [src, sel];
    if (!chosen)
      throw new AIError('CONFIG_INVALID', `no ${kind} route configured for this organization`, {
        retryable: false,
      });
    const [source, sel] = chosen;
    const fallbacks =
      sel.fallbacks ??
      (source === 'request'
        ? (org?.features[feature]?.fallbacks ?? org?.defaults[kind]?.fallbacks)
        : undefined) ??
      [];
    if (override && actor) {
      try {
        await this.audit.emit({
          action: 'override',
          organizationId,
          actorId: actor.userId,
          feature,
          after: redact(override),
          at: new Date().toISOString(),
        });
      } catch (e) {
        throw new AIError('AUDIT_FAILED', 'audit write failed; override rejected', {
          retryable: true,
          cause: e,
        });
      }
    }
    return {
      organizationId,
      feature,
      kind: kind === 'stt' ? 'stt' : 'llm',
      routeKind: kind,
      capability: FEATURE_CAPABILITY[feature],
      provider: sel.provider,
      model: sel.model,
      source,
      fallbacks,
      requireApproval: this.env.AI_REQUIRE_PROVIDER_APPROVAL,
      approvedProviders: org?.approvedProviders ?? [],
      allowPaidFallback: this.env.AI_ALLOW_PAID_FALLBACK && (org?.allowPaidFallback ?? true),
      monthlyBudgetUsd: org?.monthlyBudgetUsd,
      credentialRefs: org?.credentialRefs ?? {},
      trace: layers.map(([s, x]) => ({ source: s, selection: x })),
    };
  }
}
