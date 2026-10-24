/**
 * Output token caps (Security: unbounded maxTokens). Every LLM adapter sends a cap on every call:
 *   effective = min(requested ?? default, max, HARD_MAX_OUTPUT_TOKENS)
 * `default` and `max` come from the provider config (`outputLimits`), with a per-feature default override,
 * resolved per call by the registry. Callers can lower the cap, never raise it above `max`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const HARD_MAX_OUTPUT_TOKENS = 8192;

export type OutputLimits = { defaultMaxTokens: number; maxTokens: number };

export type OutputLimitsConfig = {
  defaultMaxTokens?: number | undefined;
  maxTokens?: number | undefined;
  perFeature?: Record<string, number> | undefined;
};

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = { defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS, maxTokens: HARD_MAX_OUTPUT_TOKENS };

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function effectiveOutputLimits(cfg: OutputLimitsConfig | undefined, feature?: string): OutputLimits {
  const max = Math.min(posInt(cfg?.maxTokens) ? cfg.maxTokens : HARD_MAX_OUTPUT_TOKENS, HARD_MAX_OUTPUT_TOKENS);
  const featureDefault = feature !== undefined ? cfg?.perFeature?.[feature] : undefined;
  const def = posInt(featureDefault) ? featureDefault : posInt(cfg?.defaultMaxTokens) ? cfg.defaultMaxTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  return { defaultMaxTokens: Math.min(def, max), maxTokens: max };
}

export function capOutputTokens(requested: number | undefined, limits: OutputLimits = DEFAULT_OUTPUT_LIMITS): number {
  const max = Math.min(limits.maxTokens, HARD_MAX_OUTPUT_TOKENS);
  const want = posInt(requested) ? requested : limits.defaultMaxTokens;
  return Math.max(1, Math.min(want, max));
}
