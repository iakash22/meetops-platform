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
  // contracts 0.12.0 REDACT_KEYS (integration secrets; access_token/refresh_token already listed above).
  'clientSecret',
  'client_secret',
  'webhookSecret',
  'privateKey',
  'privateKeyPem',
  'apiToken',
  // security review #282 M-1: snake/env/alternate spellings of integration secrets and OIDC/JWT material.
  'webhook_secret',
  'private_key',
  'pem',
  'installationToken',
  'jwt',
  'id_token',
  'GITHUB_APP_CLIENT_SECRET',
  'JIRA_CLIENT_SECRET',
  'GITHUB_APP_WEBHOOK_SECRET',
];

/**
 * Keys redacted only when the value is not shaped like an error code. `code` carries OAuth authorization codes
 * (callback query, token requests) but also error codes (`VALIDATION_FAILED`, `ECONNREFUSED`, 404) that logs need.
 */
export const CONDITIONAL_REDACT_KEYS: readonly string[] = ['code'];
const ERROR_CODE_SHAPE = /^(?:[A-Z][A-Z0-9_]{0,63}|\d{1,6}|ERR_[A-Z0-9_]+)$/;
const isErrorCode = (v: unknown) =>
  typeof v === 'number' || (typeof v === 'string' && ERROR_CODE_SHAPE.test(v));

/** Free-text scrub (#282 M-1): PEM private-key blocks and GitHub token prefixes inside any logged string. */
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const GH_TOKEN = /\bgh[osuhpr]_[A-Za-z0-9_]{16,255}\b/g;
const GH_FINE_GRAINED = /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g;
export function scrubText(s: string): string {
  if (s.length < 20) return s;
  return s.replace(PEM_BLOCK, CENSOR).replace(GH_TOKEN, CENSOR).replace(GH_FINE_GRAINED, CENSOR);
}

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

  const conditional = new Set(CONDITIONAL_REDACT_KEYS.map((k) => k.toLowerCase()));
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return scrubText(v);
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
        out.message = scrubText(v.message);
        if (v.stack) out.stack = scrubText(v.stack);
      }
      for (const [k, x] of Object.entries(v)) {
        if (budget <= 0) {
          out[k] = TRUNCATED;
          continue;
        }
        const lk = k.toLowerCase();
        out[k] =
          set.has(lk) || (conditional.has(lk) && x != null && !isErrorCode(x))
            ? CENSOR
            : walk(x, depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}
