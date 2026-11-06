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

/**
 * Live Google token endpoint and JWKS. Keys are cached for an hour and refreshed once on an unknown `kid`.
 * Redirects are refused. Response bodies are never attached to errors.
 */
export function createGoogleOAuthClient(fetchImpl: typeof fetch = fetch): GoogleOAuthClient {
  let keys = new Map<string, JsonWebKey & { kid?: string }>();
  let fetchedAt = 0;

  const refresh = async () => {
    const res = await fetchImpl(GOOGLE_JWKS_URL, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new GoogleTokenError();
    const body = (await res.json()) as JwksResponse;
    const next = new Map<string, JsonWebKey & { kid?: string }>();
    for (const key of body.keys ?? []) {
      if (key.kid && key.kty === 'RSA') next.set(key.kid, key);
    }
    if (next.size === 0) throw new GoogleTokenError();
    keys = next;
    fetchedAt = Date.now();
  };

  const keyFor = async (kid: string): Promise<JsonWebKey & { kid?: string }> => {
    const fresh = Date.now() - fetchedAt < JWKS_TTL_MS;
    if (!fresh || !keys.has(kid)) await refresh();
    const key = keys.get(kid);
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
      if (!res.ok) throw new GoogleTokenError();
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        throw new GoogleTokenError();
      }
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
