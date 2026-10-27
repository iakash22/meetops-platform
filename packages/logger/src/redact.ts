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
  // Web Push subscription `keys.auth` secret (PR #263 L-1).
  'auth',
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

/**
 * Query parameters whose values never reach logs (#282 M-2, reusable by #263 M-1): OAuth callback `code`/`state`,
 * any `token`, and OAuth/OIDC token fields that some providers echo in redirects.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  'code',
  'state',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'code_verifier',
  'signature',
  'sig',
];
/** Query parameter names that carry bearer-like values in URLs (signed links, OAuth callbacks, presigned URLs; #263 M-1). */
export const SENSITIVE_QUERY_KEYS: readonly string[] = [
  'token',
  'code',
  'state',
  'sig',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
];
const SENSITIVE_QUERY = new Set([...SENSITIVE_QUERY_PARAMS, ...SENSITIVE_QUERY_KEYS]);

/**
 * Redacts sensitive query values in a URL or path (`/cb?code=x&state=y` -> `/cb?code=***redacted***&state=...`).
 * Sensitive names: SENSITIVE_QUERY_PARAMS (#282 M-2), SENSITIVE_QUERY_KEYS (#263 M-1) and `keys` (default
 * DEFAULT_REDACT_KEYS), compared case-insensitively. Keeps parameter names and order and the path; drops the
 * fragment. A parameter NAME that cannot be percent-decoded fails closed (only the path is kept); a malformed value
 * is left as is.
 */
export function redactUrl(url: string, keys: Iterable<string> = DEFAULT_REDACT_KEYS): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const names = new Set([...SENSITIVE_QUERY, ...[...keys].map((k) => k.toLowerCase())]);
  const hash = url.indexOf('#', q);
  const end = hash < 0 ? url.length : hash;
  try {
    // `;` is a legacy pair separator some parsers honour (#282 L): split on it too, keeping the original separator.
    const query = url
      .slice(q + 1, end)
      .split(/([&;])/)
      .map((pair) => {
        if (!pair || pair === '&' || pair === ';') return pair;
        const eq = pair.indexOf('=');
        const raw = eq < 0 ? pair : pair.slice(0, eq);
        return names.has(normalizeParamName(raw)) ? `${raw}=${CENSOR}` : pair;
      })
      .join('');
    return `${url.slice(0, q)}?${query}`;
  } catch {
    return url.slice(0, q);
  }
}

/** Keys whose string values are URLs/paths and get `redactUrl` (in addition to the key list). */
/** Objects under these keys are parsed query strings: SENSITIVE_QUERY_PARAMS are redacted whatever the value shape. */
const QUERY_KEYS = new Set(['query', 'querystring', 'searchparams']);
const URL_KEYS = new Set(['url', 'originalurl', 'path', 'href', 'location', 'referer', 'referrer']);

/**
 * Canonical form of a query parameter NAME for matching (#282 L): percent/plus-decoded, NUL and other control chars
 * removed, surrounding whitespace trimmed (`code+=`), array/object suffixes dropped (`code[]=`, `code[x]=`),
 * lower-cased. Throws on undecodable names (callers fail closed).
 */
function normalizeParamName(raw: string): string {
  return (
    decodeURIComponent(raw.replace(/\+/g, ' '))
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .replace(/\[.*$/, '')
      .trim()
      .toLowerCase()
  );
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
  const walk = (v: unknown, depth: number, parentKey = ''): unknown => {
    if (typeof v === 'string') return scrubText(v);
    if (v === null || typeof v !== 'object') return v;
    if (budget-- <= 0 || depth > maxDepth) return TRUNCATED;
    const isErr = v instanceof Error;
    if (!isErr && !Array.isArray(v) && !isPlain(v)) return v;
    if (seen.has(v)) return CIRCULAR;
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const inQuery = QUERY_KEYS.has(parentKey);
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
          set.has(lk) ||
          (inQuery && SENSITIVE_QUERY.has(lk)) ||
          (conditional.has(lk) && x != null && !isErrorCode(x))
            ? CENSOR
            : URL_KEYS.has(lk) && typeof x === 'string'
              ? scrubText(redactUrl(x))
              : walk(x, depth + 1, lk);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0);
}
