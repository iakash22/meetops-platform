import { REDACT_KEYS } from '@meetops/contracts/types';

const REDACTED = '[REDACTED]';
const redactSet = new Set<string>(REDACT_KEYS.map((k) => k.toLowerCase()));

/**
 * Deep-copies `value` with every key in contracts `REDACT_KEYS` (accessToken, refreshToken, password, ...) replaced.
 * Use before anything auth-related reaches a log, an error report or a test snapshot (ADR-005 A1.5).
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactSet.has(key.toLowerCase()) ? REDACTED : redactSecrets(v, depth + 1);
  }
  return out;
}
