/**
 * Fail-closed production guard for customer data sent to LLM / STT providers.
 *
 * Defaults in `defaultProviderConfigs` are not changed here (those billing labels
 * are an owner decision). Production must explicitly declare a paid or no-training
 * data-use tier for every enabled LLM or STT provider whose configured `cost.tier`
 * is `free` or unknown. See docs/research/ai-provider-due-diligence.md and ADR-019.
 *
 * Env: `AI_PROVIDER_DATA_TIER_<PROVIDER>=paid|no-training`
 * (hyphens in the provider name become underscores, e.g. FASTER_WHISPER).
 */
/**
 * Same allow-list as #375 (`isRelaxedNodeEnv` in @meetops/integrations): only
 * `development` and `test` are non-production. Unset, typo, staging, etc. fail closed.
 */
export function isRelaxedNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

export const PRODUCTION_DATA_TIERS = ['paid', 'no-training'] as const;
export type ProductionDataTier = (typeof PRODUCTION_DATA_TIERS)[number];

export type ProviderDataTierInput = {
  name: string;
  type: string;
  enabled?: boolean | undefined;
  cost?: { tier?: string | undefined } | undefined;
};

export function dataTierEnvName(providerName: string): string {
  return `AI_PROVIDER_DATA_TIER_${providerName.replace(/-/g, '_').toUpperCase()}`;
}

export function parseProductionDataTier(
  raw: string | undefined,
): ProductionDataTier | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'paid' || v === 'no-training') return v;
  return 'invalid';
}

export type ProviderDataTierAssessment = {
  provider: string;
  type: string;
  configuredTier: string | undefined;
  declaration: ProductionDataTier | undefined;
  ok: boolean;
  reason?: string;
};

const CUSTOMER_DATA_TYPES = new Set(['llm', 'stt']);

/** A configured cost.tier of `paid` is already an explicit paid declaration. */
export function isPaidConfiguredTier(tier: string | undefined): boolean {
  return tier === 'paid';
}

export function assessEnabledProviderDataTiers(
  configs: readonly ProviderDataTierInput[],
  env: Record<string, string | undefined>,
): ProviderDataTierAssessment[] {
  const out: ProviderDataTierAssessment[] = [];
  for (const c of configs) {
    if (!c.enabled) continue;
    if (!CUSTOMER_DATA_TYPES.has(c.type)) continue;
    const configuredTier = c.cost?.tier;
    const envName = dataTierEnvName(c.name);
    const parsed = parseProductionDataTier(env[envName]);
    if (parsed === 'invalid') {
      out.push({
        provider: c.name,
        type: c.type,
        configuredTier,
        declaration: undefined,
        ok: false,
        reason: `${envName} must be paid or no-training`,
      });
      continue;
    }
    if (isPaidConfiguredTier(configuredTier) || parsed !== undefined) {
      out.push({
        provider: c.name,
        type: c.type,
        configuredTier,
        declaration: parsed ?? 'paid',
        ok: true,
      });
      continue;
    }
    out.push({
      provider: c.name,
      type: c.type,
      configuredTier,
      declaration: undefined,
      ok: false,
      reason:
        `${c.name} is enabled in production with cost.tier=` +
        `${configuredTier ?? 'unknown'}; set ${envName}=paid|no-training`,
    });
  }
  return out;
}

export class ProductionProviderDataTierError extends Error {
  readonly providers: string[];
  constructor(message: string, providers: string[]) {
    super(message);
    this.name = 'ProductionProviderDataTierError';
    this.providers = providers;
  }
}

/**
 * Refuse to build a registry that would send customer data to an LLM or STT
 * provider whose tier is free or undeclared, unless NODE_ENV is on the
 * development/test allow-list (or `opts.production` is explicitly false).
 */
export function assertProductionProviderDataTiers(
  configs: readonly ProviderDataTierInput[],
  env: Record<string, string | undefined> = {},
  opts: { production?: boolean | undefined } = {},
): void {
  const production = opts.production ?? !isRelaxedNodeEnv(env.NODE_ENV);
  if (!production) return;
  const failed = assessEnabledProviderDataTiers(configs, env).filter((a) => !a.ok);
  if (failed.length === 0) return;
  const detail = failed.map((a) => a.reason ?? a.provider).join('; ');
  throw new ProductionProviderDataTierError(
    `Refusing to process customer data in production with a free or undeclared ` +
      `AI provider tier. ${detail}`,
    failed.map((a) => a.provider),
  );
}
