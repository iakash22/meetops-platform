import { REDACT_KEYS } from '@meetops/contracts/types';

const KEYS = new Set<string>(REDACT_KEYS.map((k) => k.toLowerCase()));
export const REDACTED = '[REDACTED]';

/** Deep copy with every REDACT_KEYS key (case-insensitive, any depth) replaced (ADR-005 A1.5). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1),
    ]),
  );
}

/** Message of an error with any bearer value scrubbed, safe for logs. */
export function safeErrorMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
}
