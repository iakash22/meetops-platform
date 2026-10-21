import { Agent, type Dispatcher } from 'undici';
import { assertSafeEndpoint, type DnsLookup, type EndpointPolicy, type SafeEndpoint } from '../security/ssrf.js';
import { AIError } from '../errors.js';

export type FetchLike = (url: string, init?: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

export type HttpOpts = {
  baseUrl: string;
  policy: EndpointPolicy;
  fetch?: FetchLike | undefined;
  lookup?: DnsLookup | undefined;
  headers?: Record<string, string> | undefined;
  provider: string;
  /** Max response body bytes (default 10 MB). */
  maxResponseBytes?: number | undefined;
};

export const CONNECT_TIMEOUT_MS = 5_000;

/** undici Agent whose DNS lookup always returns the pre-validated IP; TLS SNI/Host stay the hostname. */
export function pinnedAgent(pinned: NonNullable<SafeEndpoint['pinned']>): Agent {
  return new Agent({
    connect: {
      timeout: CONNECT_TIMEOUT_MS,
      lookup: (_host, opts, cb) => {
        const all = (opts as { all?: boolean }).all;
        if (all) (cb as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [pinned]);
        else (cb as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
      },
    },
  });
}

/**
 * SSRF-guarded fetch (shared safeFetch for ai-core): validate URL + resolved IPs, pin the IP for the
 * connection, never follow redirects, cap response size.
 */
export async function guardedFetch(o: HttpOpts, path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path.replace(/^\//, ''), o.baseUrl.endsWith('/') ? o.baseUrl : `${o.baseUrl}/`).toString();
  const safe = await assertSafeEndpoint(url, o.policy, o.lookup);
  const f: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
  const dispatcher = safe.pinned ? pinnedAgent(safe.pinned) : undefined;
  try {
    const res = await f(url, {
      ...init,
      redirect: 'manual',
      headers: { ...(o.headers ?? {}), ...((init.headers as Record<string, string>) ?? {}) },
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (res.status >= 300 && res.status < 400) throw new AIError('SSRF_BLOCKED', `Redirects are not followed (${res.status})`, { provider: o.provider, retryable: false });
    const max = o.maxResponseBytes ?? 10 * 1024 * 1024;
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > max) throw new AIError('INVALID_OUTPUT', `Response too large (${len} bytes)`, { provider: o.provider, retryable: false });
    const text = await res.text();
    if (Buffer.byteLength(text) > max) throw new AIError('INVALID_OUTPUT', 'Response too large', { provider: o.provider, retryable: false });
    if (!res.ok) throw Object.assign(new Error(`${o.provider} HTTP ${res.status}: ${text.slice(0, 300)}`), { status: res.status });
    return new Response(text, { status: res.status, headers: res.headers });
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

export function requireOk(cond: unknown, provider: string, msg: string): asserts cond {
  if (!cond) throw new AIError('INVALID_OUTPUT', msg, { provider });
}
