import {
  EXPO_PUSH_API_URL,
  EXPO_PUSH_TOKEN_PATTERN,
  GENERIC_PUSH_BODY,
  GENERIC_PUSH_TITLE,
  WEB_PUSH_ALLOWED_HOSTS,
  type RegisterPushDeviceRequest,
} from '@meetops/contracts';
import { assertSafeEndpoint, type DnsLookup } from '@meetops/ai-core';

/** Thrown for any push target we refuse to store or call. Message never echoes the token or endpoint. */
export class PushTargetRejectedError extends Error {
  readonly code = 'PUSH_TARGET_REJECTED';
  constructor(reason: string) {
    super(`Push target rejected: ${reason}`);
    this.name = 'PushTargetRejectedError';
  }
}

const EXPO_RE = new RegExp(EXPO_PUSH_TOKEN_PATTERN);
const ALLOWED = new Set<string>(WEB_PUSH_ALLOWED_HOSTS);

/**
 * Static checks on a Web Push endpoint (security review C, finding 1): https, exact allowlisted host, default port,
 * no credentials, no IP literal. DNS / private-address checks run in `assertDeliverableWebPushEndpoint`.
 */
export function assertWebPushEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushTargetRejectedError('invalid URL');
  }
  if (url.protocol !== 'https:') throw new PushTargetRejectedError('HTTPS only');
  if (url.username || url.password) throw new PushTargetRejectedError('credentials in URL');
  if (url.port !== '' && url.port !== '443') throw new PushTargetRejectedError('port not allowed');
  if (!ALLOWED.has(url.hostname.toLowerCase())) throw new PushTargetRejectedError('host not allowlisted');
  return url;
}

export function assertExpoPushToken(token: string): void {
  if (typeof token !== 'string' || !EXPO_RE.test(token)) throw new PushTargetRejectedError('not an Expo push token');
}

/**
 * Validates a registration and returns the opaque string we store encrypted: the Web Push subscription JSON (endpoint
 * normalized) or the Expo token.
 */
export function pushTokenFromRegistration(req: RegisterPushDeviceRequest): string {
  if ('subscription' in req) {
    const url = assertWebPushEndpoint(req.subscription.endpoint);
    return JSON.stringify({ endpoint: url.href, keys: req.subscription.keys });
  }
  assertExpoPushToken(req.expoPushToken);
  return req.expoPushToken;
}

/**
 * Send-time guard: re-runs the static checks and the ADR-009 SSRF guard (DNS resolution, private / reserved address
 * rejection, pinned address). Callers must also disable redirects on the request.
 */
export async function assertDeliverableWebPushEndpoint(endpoint: string, lookup?: DnsLookup) {
  assertWebPushEndpoint(endpoint);
  try {
    return await assertSafeEndpoint(
      endpoint,
      { allowedHosts: [...WEB_PUSH_ALLOWED_HOSTS], allowedLocalOrigins: [] },
      lookup,
    );
  } catch {
    throw new PushTargetRejectedError('endpoint failed the SSRF guard');
  }
}

/** Expo is only ever called at this fixed URL; tokens are never used to build a URL. */
export const EXPO_PUSH_URL = EXPO_PUSH_API_URL;

export interface PushPayload {
  title: string;
  body: string;
  data: { notificationId: string };
}

/**
 * Lock-screen-safe payload (finding 3): fixed generic copy, only the notification id. No org id or name, no titles,
 * no meeting or task content; the client fetches the feed item after unlocking.
 */
export function buildPushPayload(notificationId: string): PushPayload {
  return { title: GENERIC_PUSH_TITLE, body: GENERIC_PUSH_BODY, data: { notificationId } };
}
