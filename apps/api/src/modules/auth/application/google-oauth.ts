import {
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_URL,
  GoogleTokenError,
  verifyGoogleIdToken,
  type GoogleIdentity,
  type GoogleOAuthConfig,
  type IdTokenExpectations,
} from './google-oidc.js';

export interface GoogleOAuthClient {
  /** Exchanges the authorization code. Returns the raw ID token. Never logs the code or the token. */
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    config: GoogleOAuthConfig;
  }): Promise<string>;
  verifyIdToken(idToken: string, expected: IdTokenExpectations): Promise<GoogleIdentity>;
}

interface JwksResponse {
  keys?: (JsonWebKey & { kid?: string })[];
}

const JWKS_TTL_MS = 60 * 60 * 1000;
/** OIDC review L-3 / N-5: at most one JWKS fetch per minute, whatever kids clients send. */
export const JWKS_MIN_REFRESH_INTERVAL_MS = 60 * 1000;
/** Cached keys keep serving through refresh failures, but never once they are a day old. */
export const JWKS_MAX_STALE_MS = 24 * 60 * 60 * 1000;
/** OIDC review N-6: Google's JWKS and token responses are a few KB; anything larger is refused unread. */
export const GOOGLE_MAX_RESPONSE_BYTES = 64 * 1024;

export interface GoogleOAuthClientOptions {
  /** Clock for the JWKS cache (tests). Default Date.now. */
  now?: () => number;
}

/** Reads at most `max` bytes of a response body; bigger bodies (declared or actual) are refused. */
async function readJson(res: Response, max = GOOGLE_MAX_RESPONSE_BYTES): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new GoogleTokenError();
  }
  if (!res.body) throw new GoogleTokenError();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new GoogleTokenError();
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new GoogleTokenError();
  }
}

/**
 * Live Google token endpoint and JWKS. Keys are cached for an hour. An unknown `kid` triggers a refresh at most once
 * per minute; concurrent refreshes share one request (single flight); a failed refresh keeps serving the cached keys.
 * Redirects are refused. Response bodies are size-capped and never attached to errors.
 */
export function createGoogleOAuthClient(
  fetchImpl: typeof fetch = fetch,
  options: GoogleOAuthClientOptions = {},
): GoogleOAuthClient {
  const now = options.now ?? Date.now;
  let keys = new Map<string, JsonWebKey & { kid?: string }>();
  let fetchedAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const fetchKeys = async () => {
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_JWKS_URL, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      });
    } catch {
      throw new GoogleTokenError();
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new GoogleTokenError();
    }
    const body = (await readJson(res)) as JwksResponse | null;
    const next = new Map<string, JsonWebKey & { kid?: string }>();
    for (const key of Array.isArray(body?.keys) ? body.keys : []) {
      if (key && typeof key.kid === 'string' && key.kid && key.kty === 'RSA')
        next.set(key.kid, key);
    }
    if (next.size === 0) throw new GoogleTokenError();
    keys = next;
    fetchedAt = now();
  };

  /** Single flight: callers that arrive while a fetch is running wait for that same fetch. */
  const refresh = () => {
    if (!inflight) {
      lastAttemptAt = now();
      inflight = fetchKeys().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  const keyFor = async (kid: string): Promise<JsonWebKey & { kid?: string }> => {
    const t = now();
    const stale = t - fetchedAt >= JWKS_TTL_MS;
    const throttled = t - lastAttemptAt < JWKS_MIN_REFRESH_INTERVAL_MS;
    if (inflight) {
      await inflight.catch(() => undefined);
    } else if ((stale || !keys.has(kid)) && !throttled) {
      try {
        await refresh();
      } catch {
        // Fall back to the cached keys (N-5). With no cache at all the lookup below fails closed.
      }
    }
    const key = now() - fetchedAt < JWKS_MAX_STALE_MS ? keys.get(kid) : undefined;
    if (key) return key;
    throw new GoogleTokenError();
  };

  return {
    async exchangeCode({ code, codeVerifier, config }) {
      const body = new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      });
      let res: Response;
      try {
        res = await fetchImpl(GOOGLE_TOKEN_URL, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        });
      } catch {
        throw new GoogleTokenError();
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new GoogleTokenError();
      }
      const parsed = await readJson(res);
      const idToken =
        parsed && typeof parsed === 'object' && 'id_token' in parsed
          ? (parsed as { id_token?: unknown }).id_token
          : undefined;
      if (typeof idToken !== 'string' || idToken.length === 0) throw new GoogleTokenError();
      return idToken;
    },
    async verifyIdToken(idToken, expected) {
      const parts = idToken.split('.');
      if (parts.length !== 3 || !parts[0]) throw new GoogleTokenError();
      let kid: string;
      try {
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
          kid?: unknown;
        };
        if (typeof header.kid !== 'string') throw new GoogleTokenError();
        kid = header.kid;
      } catch (e) {
        if (e instanceof GoogleTokenError) throw e;
        throw new GoogleTokenError();
      }
      let key: JsonWebKey & { kid?: string };
      try {
        key = await keyFor(kid);
      } catch (e) {
        if (e instanceof GoogleTokenError) throw e;
        throw new GoogleTokenError();
      }
      return verifyGoogleIdToken(idToken, key, expected);
    },
  };
}
