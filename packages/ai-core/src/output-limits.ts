/**
 * Output token caps (Security: unbounded maxTokens). Every LLM adapter sends a cap on every call:
 *   effective = min(requested ?? default, max, HARD_MAX_OUTPUT_TOKENS)
 * `default` and `max` come from the provider config (`outputLimits`), with a per-feature default override,
 * resolved per call by the registry. Callers can lower the cap, never raise it above `max`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const HARD_MAX_OUTPUT_TOKENS = 8192;

/** Pipeline step keys (e.g. map-reduce). A step default applies when the caller does not pass maxTokens. */
export const OUTPUT_STEPS = ['map', 'reduce'] as const;
export type OutputStep = (typeof OUTPUT_STEPS)[number];

export type OutputLimits = { defaultMaxTokens: number; maxTokens: number; perStep?: Partial<Record<OutputStep, number>> | undefined };

export type OutputLimitsConfig = {
  defaultMaxTokens?: number | undefined;
  maxTokens?: number | undefined;
  perFeature?: Record<string, number> | undefined;
  /** Step defaults for every feature, e.g. { reduce: 4096 }. */
  perStep?: Partial<Record<OutputStep, number>> | undefined;
  /** Feature-specific step defaults, highest precedence: { summary: { reduce: 4096 } }. */
  perFeatureStep?: Record<string, Partial<Record<OutputStep, number>>> | undefined;
};

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = { defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS, maxTokens: HARD_MAX_OUTPUT_TOKENS };

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function effectiveOutputLimits(cfg: OutputLimitsConfig | undefined, feature?: string): OutputLimits {
  const max = Math.min(posInt(cfg?.maxTokens) ? cfg.maxTokens : HARD_MAX_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS);
  const featureDefault = feature !== undefined ? cfg?.perFeature?.[feature] : undefined;
  const def = posInt(featureDefault) ? featureDefault : posInt(cfg?.defaultMaxTokens) ? cfg.defaultMaxTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  const perStep: Partial<Record<OutputStep, number>> = {};
  for (const step of OUTPUT_STEPS) {
    const v = (feature !== undefined ? cfg?.perFeatureStep?.[feature]?.[step] : undefined) ?? cfg?.perStep?.[step];
    if (posInt(v)) perStep[step] = Math.min(v, max);
  }
  return { defaultMaxTokens: Math.min(def, max), maxTokens: max, ...(Object.keys(perStep).length ? { perStep } : {}) };
}

/** Precedence: requested > step default > feature/provider default; always clamped to max and the hard max. */
export function capOutputTokens(requested: number | undefined, limits: OutputLimits = DEFAULT_OUTPUT_LIMITS, step?: OutputStep): number {
  const max = Math.min(limits.maxTokens, HARD_MAX_OUTPUT_TOKENS);
  const stepDefault = step !== undefined ? limits.perStep?.[step] : undefined;
  const want = posInt(requested) ? requested : posInt(stepDefault) ? stepDefault : limits.defaultMaxTokens;
  return Math.max(1, Math.min(want, max));
}
