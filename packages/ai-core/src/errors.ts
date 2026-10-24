export type AIErrorCode =
  | 'MISSING_CREDENTIALS'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_UNAVAILABLE'
  | 'CAPABILITY_UNSUPPORTED'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'MODEL_ERROR'
  | 'TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'UNAUTHORIZED_OVERRIDE'
  | 'PAID_FALLBACK_BLOCKED'
  | 'SSRF_BLOCKED'
  | 'CONFIG_INVALID'
  | 'FORBIDDEN'
  | 'AUDIT_FAILED'
  | 'UNKNOWN';

const RETRYABLE: ReadonlySet<AIErrorCode> = new Set(['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_UNAVAILABLE', 'MODEL_ERROR']);

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly provider: string | undefined;
  readonly retryable: boolean;
  constructor(code: AIErrorCode, message: string, opts: { provider?: string; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AIError';
    this.code = code;
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
  }
}

/** Map an arbitrary provider/SDK/HTTP error into an AIError. */
export function toAIError(err: unknown, provider?: string): AIError {
  if (err instanceof AIError) return err;
  const e = err as { status?: number; code?: number | string; message?: string; name?: string };
  const status = typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : undefined;
  const msg = e?.message ?? String(err);
  const base = provider === undefined ? { cause: err } : { provider, cause: err };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new AIError('TIMEOUT', msg, base);
  if (status === 429) {
    return /quota|exhausted|billing/i.test(msg)
      ? new AIError('QUOTA_EXCEEDED', msg, { ...base, retryable: false })
      : new AIError('RATE_LIMITED', msg, base);
  }
  if (status === 401 || status === 403) return new AIError('MISSING_CREDENTIALS', msg, { ...base, retryable: false });
  if (status !== undefined && status >= 500) return new AIError('PROVIDER_UNAVAILABLE', msg, base);
  if (status === 404) return new AIError('MODEL_ERROR', msg, { ...base, retryable: false });
  return new AIError('UNKNOWN', msg, { ...base, retryable: false });
}

/** Client-safe error view: code + requestId only. Provider messages / keys never leave the server. */
export type PublicAIError = { code: AIErrorCode; requestId?: string | undefined; retryable: boolean };
export function toPublicError(err: unknown, requestId?: string): PublicAIError {
  const e = toAIError(err);
  return requestId === undefined ? { code: e.code, retryable: e.retryable } : { code: e.code, requestId, retryable: e.retryable };
}
