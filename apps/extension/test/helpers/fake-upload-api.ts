/**
 * Typed fake of the recording-session API (contracts paths and payloads) behind `ApiFetch`/`FetchLike`.
 * Returns real `Response` objects; every call is recorded. No msw, no network.
 */
import { hexToBase64 } from '../../src/lib/upload.js';

export type Call = { url: string; init: RequestInit };
export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
/** Override for one request; return undefined to fall through to the default behaviour. */
export type Override = (call: Call, route: Route) => Reply | undefined;

export type Route =
  | { op: 'init'; organizationId: string }
  | { op: 'chunks' | 'complete' | 'abort'; sessionId: string }
  | { op: 'put'; sessionId: string; seq: number };

const UUID = '[0-9a-f-]{36}';

export function route(url: string, method: string | undefined): Route | undefined {
  const u = new URL(url, 'https://api.meetops.test');
  const p = u.pathname;
  let m: RegExpMatchArray | null;
  if (method === 'PUT' && (m = p.match(new RegExp(`^/put/(${UUID})/(\\d+)$`)))) {
    return { op: 'put', sessionId: m[1]!, seq: Number(m[2]) };
  }
  if (method !== 'POST') return undefined;
  if ((m = p.match(new RegExp(`^/orgs/(${UUID})/recording-sessions$`)))) {
    return { op: 'init', organizationId: m[1]! };
  }
  if ((m = p.match(new RegExp(`^/recording-sessions/(${UUID})/(chunks|complete|abort)$`)))) {
    return { op: m[2] as 'chunks' | 'complete' | 'abort', sessionId: m[1]! };
  }
  return undefined;
}

export const STORAGE = 'https://storage.meetops.test';

export function errorBody(code: string, message = 'safe message', reason?: string) {
  return { error: { code, message, requestId: 'req_1', ...(reason ? { reason } : {}) } };
}

export function createFakeUploadApi(
  opts: {
    sessionId: string;
    now: () => number;
    ttlMs?: number | undefined;
    storageOrigin?: string;
  } = {
    sessionId: '7d9f2c1e-3b4a-4c5d-8e6f-0a1b2c3d4e5f',
    now: Date.now,
  },
) {
  const calls: Call[] = [];
  const overrides: Override[] = [];
  const objects = new Map<number, { bytes: number; checksum: string }>();
  const toResponse = (r: Reply): Response => {
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? {},
    });
  };

  const defaults = async (call: Call, rt: Route): Promise<Reply> => {
    const body = (typeof call.init.body === 'string' ? JSON.parse(call.init.body) : {}) as {
      seq: number;
      sizeBytes: number;
      sha256: string;
    };
    switch (rt.op) {
      case 'init':
        return { status: 201, body: { sessionId: opts.sessionId } };
      case 'chunks': {
        const expiresAt = new Date(opts.now() + (opts.ttlMs ?? 900_000)).toISOString();
        return {
          status: 200,
          body: {
            seq: body.seq,
            upload: {
              url: `${opts.storageOrigin ?? STORAGE}/put/${rt.sessionId}/${body.seq}?sig=x`,
              method: 'PUT',
              headers: {
                'content-length': String(body.sizeBytes),
                'x-amz-checksum-sha256': hexToBase64(body.sha256),
              },
              expiresAt,
            },
          },
        };
      }
      case 'put': {
        const h = new Headers(call.init.headers);
        const buf = await new Response(call.init.body as BodyInit).arrayBuffer();
        objects.set(rt.seq, {
          bytes: buf.byteLength,
          checksum: h.get('x-amz-checksum-sha256') ?? '',
        });
        return { status: 200 };
      }
      case 'complete':
        return { status: 200, body: { status: 'uploaded' } };
      case 'abort':
        return { status: 204 };
    }
  };

  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const call = { url, init };
    calls.push(call);
    const rt = route(url, init.method);
    if (!rt) return toResponse({ status: 404, body: errorBody('NOT_FOUND') });
    for (const o of overrides) {
      const r = o(call, rt);
      if (r !== undefined) return toResponse(r);
    }
    return toResponse(await defaults(call, rt));
  };

  return {
    fetch,
    calls,
    objects,
    /** Queue `replies` for the next requests matching `op`, in order. */
    reply(op: Route['op'], ...replies: Reply[]) {
      overrides.push((_c, rt) => (rt.op === op ? replies.shift() : undefined));
    },
    ops: () => calls.map((c) => route(c.url, c.init.method)?.op ?? `?${c.url}`),
    of: (op: Route['op']) => calls.filter((c) => route(c.url, c.init.method)?.op === op),
  };
}

export const jsonBody = (c: Call) => JSON.parse(c.init.body as string) as Record<string, unknown>;
export const authz = (c: Call) => new Headers(c.init.headers).get('authorization');
