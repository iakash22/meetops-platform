import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Authorization-code + PKCE. The browser never sees the client secret or the ID token. */
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Login only. Calendar scopes stay on the separate calendar client. */
export const GOOGLE_LOGIN_SCOPE = 'openid email profile';
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
/** How long the state cookie and the authorize round-trip may live. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_NEXT_LENGTH = 512;
const CLOCK_SKEW_MS = 60_000;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Exact redirect URI registered in Google Cloud. Never taken from the request. */
  redirectUri: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export interface OAuthStatePayload {
  state: string;
  nonce: string;
  verifier: string;
  /** Already passed through safeNext. */
  next: string;
  exp: number;
}

export class GoogleTokenError extends Error {
  constructor() {
    super('Google sign-in could not be verified');
    this.name = 'GoogleTokenError';
  }
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Same-origin relative path only. Rejects protocol-relative, absolute, and control-character targets. */
export function safeNext(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || target.length === 0 || target.length > MAX_NEXT_LENGTH)
    return fallback;
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return fallback;
  if (target.includes('://')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return fallback;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return fallback;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    decoded.includes('://') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(decoded)
  )
    return fallback;
  return target;
}

export function createPkceVerifier(): string {
  return b64url(randomBytes(32));
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newOAuthState(next: unknown, now: number): OAuthStatePayload {
  return {
    state: b64url(randomBytes(32)),
    nonce: b64url(randomBytes(32)),
    verifier: createPkceVerifier(),
    next: safeNext(next),
    exp: now + OAUTH_STATE_TTL_MS,
  };
}

/** Cookie value is `payload.hmac`. The HMAC key is CSRF_SECRET. The verifier never leaves this cookie. */
export function sealOAuthState(payload: OAuthStatePayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function openOAuthState(
  cookie: string | undefined,
  queryState: string | undefined,
  secret: Buffer,
  now: number,
): OAuthStatePayload | null {
  if (!cookie || !queryState || queryState.length > 128) return null;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = cookie.slice(0, dot);
  const mac = cookie.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return null;
  }
  if (
    typeof payload.state !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.verifier !== 'string' ||
    typeof payload.next !== 'string' ||
    typeof payload.exp !== 'number'
  )
    return null;
  if (!safeEqual(payload.state, queryState)) return null;
  if (payload.exp <= now || payload.exp - now > OAUTH_STATE_TTL_MS + CLOCK_SKEW_MS) return null;
  if (payload.verifier.length < 43 || payload.verifier.length > 128) return null;
  if (payload.nonce.length < 32) return null;
  return { ...payload, next: safeNext(payload.next) };
}

export function googleAuthorizeUrl(config: GoogleOAuthConfig, flow: OAuthStatePayload): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_LOGIN_SCOPE);
  url.searchParams.set('state', flow.state);
  url.searchParams.set('nonce', flow.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(flow.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('include_granted_scopes', 'false');
  return url.toString();
}

export function assertGoogleRedirectUri(uri: string, nodeEnv: string | undefined): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('GOOGLE_OAUTH_REDIRECT_URI must be an absolute URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'GOOGLE_OAUTH_REDIRECT_URI must not include credentials, a query, or a fragment',
    );
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const https = url.protocol === 'https:';
  const devHttp = url.protocol === 'http:' && nodeEnv !== 'production' && local;
  if (!https && !devHttp) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_URI must be https, or http://localhost in development');
  }
  if (!url.pathname.endsWith('/auth/google/callback')) {
    throw new Error('GOOGLE_OAUTH_REDIRECT_URI path must end with /auth/google/callback');
  }
}

/**
 * All three variables, or none. A partial set fails startup so sign-in cannot come up half-configured.
 * The secret is never returned in logs by this function.
 */
export function readGoogleOAuthConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: string | undefined,
): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ?? '';
  if (!clientId && !clientSecret && !redirectUri) return null;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google sign-in needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI together',
    );
  }
  if (!/^[A-Za-z0-9._-]{10,200}$/.test(clientId)) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is not a valid Google client id');
  }
  if (clientSecret.length < 8 || clientSecret.length > 512 || /[\r\n]/.test(clientSecret)) {
    throw new Error('GOOGLE_OAUTH_CLIENT_SECRET length is invalid');
  }
  assertGoogleRedirectUri(redirectUri, nodeEnv);
  return { clientId, clientSecret, redirectUri };
}

/** WEB_BASE_URL must be one of WEB_ORIGINS. The callback never redirects anywhere else. */
export function assertGoogleWebOrigin(webBaseUrl: string, allowedOrigins: string[]): void {
  let origin: string;
  try {
    const url = new URL(webBaseUrl);
    if (url.username || url.password) throw new Error('credentials');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol');
    origin = url.origin;
  } catch {
    throw new Error('WEB_BASE_URL must be an absolute http(s) URL when Google sign-in is enabled');
  }
  if (!allowedOrigins.includes(origin)) {
    throw new Error(
      'WEB_BASE_URL origin must be listed in WEB_ORIGINS when Google sign-in is enabled',
    );
  }
}

export interface IdTokenExpectations {
  audience: string;
  nonce: string;
  now: Date;
}

interface JwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new GoogleTokenError();
  }
}

/**
 * Verifies an RS256 ID token against a Google JWK. Rejects any other alg, a bad nonce, a wrong
 * audience, an unverified email, and expired tokens. Does not contact the network.
 */
export function verifyGoogleIdToken(
  idToken: string,
  jwk: JsonWebKey & { kid?: string },
  expected: IdTokenExpectations,
): GoogleIdentity {
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 8192) {
    throw new GoogleTokenError();
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new GoogleTokenError();
  const header = decodeJson(parts[0]) as JwtHeader;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new GoogleTokenError();
  }
  if (header.typ !== undefined && header.typ !== 'JWT') throw new GoogleTokenError();
  if (jwk.kid !== undefined && jwk.kid !== header.kid) throw new GoogleTokenError();
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) throw new GoogleTokenError();

  let signatureOk = false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    signatureOk = verifier.verify(key, Buffer.from(parts[2], 'base64url'));
  } catch {
    throw new GoogleTokenError();
  }
  if (!signatureOk) throw new GoogleTokenError();

  const claims = decodeJson(parts[1]);
  if (!claims || typeof claims !== 'object') throw new GoogleTokenError();
  const c = claims as Record<string, unknown>;
  if (
    typeof c.iss !== 'string' ||
    !GOOGLE_ISSUERS.includes(c.iss as (typeof GOOGLE_ISSUERS)[number])
  ) {
    throw new GoogleTokenError();
  }
  const audOk =
    c.aud === expected.audience ||
    (Array.isArray(c.aud) &&
      c.aud.length > 0 &&
      c.aud.every((a) => typeof a === 'string') &&
      c.aud.includes(expected.audience));
  if (!audOk) throw new GoogleTokenError();
  if (c.azp !== undefined && c.azp !== expected.audience) throw new GoogleTokenError();
  if (typeof c.nonce !== 'string' || !safeEqual(c.nonce, expected.nonce))
    throw new GoogleTokenError();

  const now = expected.now.getTime();
  if (typeof c.exp !== 'number' || c.exp * 1000 + CLOCK_SKEW_MS <= now)
    throw new GoogleTokenError();
  if (typeof c.iat !== 'number' || c.iat * 1000 - CLOCK_SKEW_MS > now) throw new GoogleTokenError();
  if (typeof c.nbf === 'number' && c.nbf * 1000 - CLOCK_SKEW_MS > now) throw new GoogleTokenError();
  if (typeof c.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(c.sub))
    throw new GoogleTokenError();
  if (c.email_verified !== true) throw new GoogleTokenError();
  if (typeof c.email !== 'string') throw new GoogleTokenError();
  const name = typeof c.name === 'string' ? c.name : null;
  return { sub: c.sub, email: c.email, emailVerified: true, name };
}
