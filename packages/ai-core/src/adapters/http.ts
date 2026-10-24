import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { assertSafeEndpoint, type DnsLookup, type EndpointPolicy, type SafeEndpoint } from '../security/ssrf.js';
import { AIError } from '../errors.js';

export type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | FormData;
  signal?: AbortSignal;
  redirect?: 'manual';
  dispatcher?: Dispatcher;
};
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export type HttpOpts = {
  baseUrl: string;
  policy: EndpointPolicy;
  /** Test seam only. Production uses undici's own fetch so the pinned dispatcher is honoured. */
  fetch?: FetchLike | undefined;
  lookup?: DnsLookup | undefined;
  headers?: Record<string, string> | undefined;
  provider: string;
  /** Max response body bytes (default 10 MB), enforced while streaming. */
  maxResponseBytes?: number | undefined;
};

export const CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** undici Agent whose DNS lookup always returns the pre-validated IP; TLS SNI/Host stay the hostname. */
export function pinnedAgent(pinned: NonNullable<SafeEndpoint['pinned']>): Agent {
  return new Agent({
    connect: {
      timeout: CONNECT_TIMEOUT_MS,
      lookup: (_host, opts, cb) => {
        if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [pinned]);
        else (cb as unknown as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family);
      },
    },
  });
}

const undiciAsFetchLike: FetchLike = (u, i) => undiciFetch(u, i as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

/** Read a body with a hard byte cap, aborting the stream as soon as it is exceeded. */
export async function readCapped(res: Response, max: number, provider: string): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > max) throw new AIError('INVALID_OUTPUT', 'Response too large', { provider, retryable: false });
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new AIError('INVALID_OUTPUT', 'Response too large', { provider, retryable: false });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/**
 * SSRF-guarded fetch: validate URL + resolved IPs, pin the IP via an undici dispatcher, never follow redirects,
 * cap response size while streaming. Error messages never include response bodies or headers.
 */
export async function guardedFetch(o: HttpOpts, pathOrUrl: string, init: Omit<FetchInit, 'dispatcher' | 'redirect'> = {}): Promise<{ status: number; headers: Headers; body: Uint8Array; json<T>(): T; text(): string }> {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : new URL(pathOrUrl.replace(/^\//, ''), o.baseUrl.endsWith('/') ? o.baseUrl : `${o.baseUrl}/`).toString();
  const safe = await assertSafeEndpoint(url, o.policy, o.lookup);
  const f = o.fetch ?? undiciAsFetchLike;
  const dispatcher = safe.pinned ? pinnedAgent(safe.pinned) : undefined;
  try {
    const res = await f(url, { ...init, redirect: 'manual', headers: { ...(o.headers ?? {}), ...(init.headers ?? {}) }, ...(dispatcher ? { dispatcher } : {}) });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new AIError('SSRF_BLOCKED', `Redirect refused (${res.status})`, { provider: o.provider, retryable: false });
    }
    const body = await readCapped(res, o.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, o.provider);
    const text = () => new TextDecoder().decode(body);
    if (res.status < 200 || res.status >= 300) {
      // Keep a short body snippet only for quota detection; never surfaced to clients (see toPublicError).
      throw Object.assign(new Error(`${o.provider} HTTP ${res.status} ${/quota|exhausted|billing/i.test(text()) ? 'quota' : ''}`.trim()), { status: res.status });
    }
    return { status: res.status, headers: res.headers, body, text, json: <T>() => JSON.parse(text()) as T };
  } finally {
    await dispatcher?.close().catch(() => undefined);
  }
}

export function requireOk(cond: unknown, provider: string, msg: string): asserts cond {
  if (!cond) throw new AIError('INVALID_OUTPUT', msg, { provider });
}
