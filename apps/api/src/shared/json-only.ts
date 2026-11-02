import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * P9 R16: extra request media types (lower-case base types, e.g. `application/x-www-form-urlencoded`) this route
     * accepts besides `application/json`. Every entry must be justified in docs/12-security/security-headers.md.
     */
    allowedContentTypes?: readonly string[];
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `Content-Type: Application/JSON; charset=utf-8` → `application/json`. */
export const baseMediaType = (raw: string | undefined) =>
  (raw ?? '').split(';')[0]!.trim().toLowerCase();

const hasBody = (headers: Record<string, string | string[] | undefined>) => {
  const len = headers['content-length'];
  if (typeof len === 'string' && len.trim() !== '' && Number(len) > 0) return true;
  return headers['transfer-encoding'] !== undefined;
};

export class UnsupportedMediaTypeError extends Error {
  readonly statusCode = 415;
  readonly code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
  constructor() {
    super('Unsupported Media Type');
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * P9 R16: a POST/PUT/PATCH/DELETE that carries a body must be `application/json` (any parameters), unless the route
 * lists the type in `config.allowedContentTypes`. This closes the "simple request" form/text CSRF vector (a
 * cross-site `<form>` or `fetch(..., {mode:'no-cors'})` can only send text/plain, form-urlencoded or multipart).
 * Runs onRequest, before body parsing. Empty-body mutations (no Content-Length or 0) are unaffected.
 */
export function registerJsonOnly(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    if (!UNSAFE.has(request.method) || !hasBody(request.headers)) return;
    const type = baseMediaType(request.headers['content-type']);
    if (type === 'application/json') return;
    const allowed = request.routeOptions.config.allowedContentTypes ?? [];
    if (type && allowed.includes(type)) return;
    throw new UnsupportedMediaTypeError();
  });
}
