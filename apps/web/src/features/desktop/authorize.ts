/**
 * /desktop/authorize helpers (ADR-012 §1, Option A: system browser + PKCE + loopback redirect).
 *
 * TODO(contracts): ADR-012 is still Proposed and `@meetops/contracts` has no desktop types yet, so the request and
 * response shapes below are local and mirror ADR-012 §1.4-1.6. Replace them with contract imports once Architecture
 * adds them. The server re-validates every field; these checks only stop the page from offering a bad link.
 */
export const DESKTOP_AUTHORIZE_PATH = '/auth/desktop/authorize';

export type DesktopAuthorizeRequest = {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri: string;
  deviceId: string;
  deviceLabel?: string;
};

export type DesktopAuthorizeResponse = { code: string };

export type DesktopAuthorizeSearch = {
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  redirect_uri?: string;
  device_id?: string;
  device_label?: string;
};

const KEYS = [
  'state',
  'code_challenge',
  'code_challenge_method',
  'redirect_uri',
  'device_id',
  'device_label',
] as const;

/** 256-bit base64url state is 43 chars; allow some headroom. */
const STATE = /^[A-Za-z0-9_-]{43,128}$/;
/** S256 challenge: base64url SHA-256, exactly 43 chars (RFC 7636 §4.2). */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Authorization codes are opaque base64url with 256 bits of entropy. */
const AUTH_CODE = /^[A-Za-z0-9_-]{43,128}$/;

export function parseDesktopAuthorizeSearch(
  search: Record<string, unknown>,
): DesktopAuthorizeSearch {
  const out: DesktopAuthorizeSearch = {};
  for (const key of KEYS) {
    const v = search[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  return out;
}

/**
 * ADR-012 §1.5: scheme http, host exactly 127.0.0.1, any port, path /callback, no query, fragment or userinfo.
 * Returns the normalized URI or null.
 */
export function validateLoopbackRedirect(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return null;
  if (url.pathname !== '/callback' || url.search || url.hash) return null;
  if (url.username || url.password) return null;
  if (raw.includes('?') || raw.includes('#') || raw.includes('@')) return null;
  const port = Number(url.port);
  if (!url.port || !Number.isInteger(port) || port < 1024 || port > 65535) return null;
  return `http://127.0.0.1:${port}/callback`;
}

function isUnsafeLabelChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    c === 0x2060 ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff ||
    c === 0x061c ||
    ['<', '>', '"', "'", '&'].includes(ch)
  );
}

/** Build the authorize request from the URL, or null if anything required is missing or malformed. */
export function toDesktopAuthorizeRequest(
  search: DesktopAuthorizeSearch,
): DesktopAuthorizeRequest | null {
  const { state, code_challenge, code_challenge_method, device_id, device_label } = search;
  if (!state || !STATE.test(state)) return null;
  if (!code_challenge || !CODE_CHALLENGE.test(code_challenge)) return null;
  if (code_challenge_method !== 'S256') return null;
  if (!device_id || !UUID.test(device_id)) return null;
  const redirectUri = validateLoopbackRedirect(search.redirect_uri);
  if (!redirectUri) return null;
  const label = device_label?.trim();
  const validLabel =
    label && label.length <= 100 && ![...label].some(isUnsafeLabelChar) ? label : undefined;
  return {
    state,
    codeChallenge: code_challenge,
    codeChallengeMethod: 'S256',
    redirectUri,
    deviceId: device_id,
    ...(validLabel ? { deviceLabel: validLabel } : {}),
  };
}

export function isValidAuthorizationCode(code: unknown): code is string {
  return typeof code === 'string' && AUTH_CODE.test(code);
}

/** ADR-012 §1.6: `redirect_uri?code=…&state=…`. */
export function buildCallbackUrl(redirectUri: string, code: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', state);
  return url.toString();
}
