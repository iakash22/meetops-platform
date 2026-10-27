/**
 * Deep, key-based redaction for log objects (ADR-005 A1.5). pino's `redact.paths` (fast-redact) only matches fixed
 * paths; `*` is a single level, so `*.token` misses `a.b.token`. This walker matches key names case-insensitively at
 * any depth, replacing values (never truncating them), and is capped so a huge or cyclic object cannot stall logging.
 */
export const CENSOR = '***redacted***';
export const TRUNCATED = '[Truncated]';
export const CIRCULAR = '[Circular]';

/**
 * Built-in keys: a superset of `@meetops/contracts` REDACT_KEYS (asserted by apps/api tests; this package does not
 * depend on contracts) plus the generic secret names the logger has always covered. Apps pass REDACT_KEYS too.
 */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'accessToken',
  'refreshToken',
  'pairingCode',
  // ADR-013 push credentials.
  'expoPushToken',
  'p256dh',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'csrfToken',
  'x-csrf-token',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'access_token',
  'refresh_token',
  'nonce',
  // contracts 0.9.0 REDACT_KEYS (ADR-012 desktop PKCE exchange).
  'authorizationCode',
  'codeVerifier',
  'code_verifier',
];

export interface RedactLimits {
  /** Nesting below this depth is replaced with TRUNCATED. Default 10. */
  maxDepth?: number;
  /** Total values visited per log call; the rest become TRUNCATED. Default 2000. */
  maxNodes?: number;
}

const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v) as unknown;
  return p === Object.prototype || p === null;
};

/**
 * Returns a redacted copy. Walks plain objects, arrays and Errors (message/stack/name kept, own enumerable props
 * walked). Other class instances (requests, buffers, dates) are returned as-is for pino's serializers.
 */
export function redactDeep(
  value: unknown,
  keys: Iterable<string>,
  limits: RedactLimits = {},
): unknown {
  const set = new Set([...keys].map((k) => k.toLowerCase()));
  const maxDepth = limits.maxDepth ?? 10;
  let budget = limits.maxNodes ?? 2000;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (budget-- <= 0 || depth > maxDepth) return TRUNCATED;
    const isErr = v instanceof Error;
    if (!isErr && !Array.isArray(v) && !isPlain(v)) return v;
    if (seen.has(v)) return CIRCULAR;
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out: Record<string, unknown> = {};
      if (isErr) {
        out.type = v.name;
        out.message = v.message;
        if (v.stack) out.stack = v.stack;
      }
      for (const [k, x] of Object.entries(v)) {
        if (budget <= 0) {
          out[k] = TRUNCATED;
          continue;
        }
        out[k] = set.has(k.toLowerCase()) ? CENSOR : walk(x, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}
