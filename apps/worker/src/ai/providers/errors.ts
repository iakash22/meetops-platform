/** Provider-neutral error codes. Messages never carry keys, URLs with tokens, or response bodies. */
export type ProviderErrorCode =
  | 'auth'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_request'
  | 'timeout'
  | 'provider_failed'
  | 'bad_response';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'rate_limited',
  'unavailable',
  'timeout',
]);

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly provider: string,
    readonly code: ProviderErrorCode,
    readonly status?: number,
  ) {
    super(`${provider} request failed: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
  }
}

export function errorFromStatus(provider: string, status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError(provider, 'auth', status);
  if (status === 408) return new ProviderError(provider, 'timeout', status);
  if (status === 429) return new ProviderError(provider, 'rate_limited', status);
  if (status >= 500) return new ProviderError(provider, 'unavailable', status);
  return new ProviderError(provider, 'invalid_request', status);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One HTTP call with a per-request timeout. Network/abort failures map to provider codes (no raw error text). */
export async function providerFetch(
  provider: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: combined });
  } catch {
    throw new ProviderError(
      provider,
      timeout.aborted || signal?.aborted ? 'timeout' : 'unavailable',
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw errorFromStatus(provider, res.status);
  }
  return res;
}

export async function readJson(provider: string, res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new ProviderError(provider, 'bad_response');
  }
}
