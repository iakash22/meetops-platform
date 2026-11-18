import { clientIpKey, type RateLimiter } from './rate-limit-core.js';
import { consumeGuarded, type LimitWindow } from './guarded-limit.js';

/**
 * P9 remaining-work #9: central rate-limit config for routes outside auth that had no limiter (coverage table in
 * docs/p9/rate-limit-coverage.md). Module-owned limits stay where they are and are listed there too:
 * AUTH_LIMITS, INVITE_LIMITS, EXTENSION_LIMITS, DESKTOP_LIMITS, RESOLVE_LIMITS / CREATE_LIMITS, SEARCH_*_RATE_LIMIT,
 * MEDIA_RATE_LIMITS, WEBHOOK_RATE_LIMITS.
 *
 * Every bucket goes through consumeGuarded: over the limit -> 429 + Retry-After; limiter error or timeout -> 503 +
 * Retry-After (fail closed, never an unmetered pass).
 *
 * Keys:
 * - perUser: `rl:<scope>:org:<org>:user:<user>` (authenticated routes, after the tenancy check; org-less routes
 *   (POST /orgs) use `rl:<scope>:user:<user>`);
 * - perOrg:  `rl:<scope>:org:<org>` (org-wide ceiling, charged only once the caller's own bucket allowed the request,
 *   so one user cannot spend more than their own cap of the org budget and no org can touch another org's keys);
 * - perIp:   `rl:<scope>:ip:<ip>` (public routes; `ip` is requestMeta().ip, i.e. ADR-014 clientIp after the
 *   TRUST_PROXY allowlist / pinned Cloudflare edge, never raw X-Forwarded-For). No IP -> 503 (clientIpKey), never a
 *   shared `unknown` bucket.
 */
export type RouteLimit = {
  readonly perIp?: LimitWindow;
  readonly perUser?: LimitWindow;
  readonly perOrg?: LimitWindow;
};

const MIN = 60_000;
const HOUR = 60 * MIN;

export const ROUTE_RATE_LIMITS = {
  /**
   * GET /orgs/:org/uploads/:id/download-url mints a presigned GET (TTL <= 300 s). A player or list view asks for a
   * handful per page; 120/min per user is far above that and bounds URL minting / storage egress per account.
   */
  downloadUrl: { perUser: { limit: 120, windowMs: MIN }, perOrg: { limit: 1_200, windowMs: MIN } },
  /** Meeting + task analytics share one bucket: SQL aggregates over up to MAX_ANALYTICS_RANGE_DAYS. */
  analytics: { perUser: { limit: 30, windowMs: MIN }, perOrg: { limit: 300, windowMs: MIN } },
  /** GET /orgs/:org/calendar/events may call the calendar provider (Google/Microsoft quota is per app). */
  calendarEvents: { perUser: { limit: 60, windowMs: MIN }, perOrg: { limit: 600, windowMs: MIN } },
  /** Integration + calendar connect: each call writes a one-time OAuth state; a person connects a few times a day. */
  oauthConnect: { perUser: { limit: 10, windowMs: MIN }, perOrg: { limit: 60, windowMs: MIN } },
  /**
   * Integration + calendar OAuth callbacks (GET, browser redirect). Charged per client IP before the session lookup
   * and the provider token exchange; a real user hits it once per connect.
   */
  oauthCallback: { perIp: { limit: 30, windowMs: MIN } },
  /** Issue push / task-sync request: each one is a write to GitHub/Jira under the org's installation. */
  issuePush: { perUser: { limit: 30, windowMs: MIN }, perOrg: { limit: 120, windowMs: MIN } },
  /** POST /me/push-devices: a device registers on install / token rotation. */
  pushDeviceRegister: { perUser: { limit: 20, windowMs: HOUR } },
  /** POST /orgs, per user (no org yet, so the key is `rl:orgCreate:user:<id>`): bounds scripted tenant creation. */
  orgCreate: { perUser: { limit: 10, windowMs: HOUR } },
  /**
   * POST /orgs/:org/meetings/:id/consent (record a grant). A participant attests once per meeting; 30/min per user
   * is well above that and bounds ledger writes.
   */
  consentRecord: { perUser: { limit: 30, windowMs: MIN }, perOrg: { limit: 300, windowMs: MIN } },
  /** POST /orgs/:org/meetings/:id/consent/revoke. Revokes are rarer than grants. */
  consentRevoke: { perUser: { limit: 30, windowMs: MIN }, perOrg: { limit: 300, windowMs: MIN } },
  /** PATCH /orgs/:org/settings/consent (owner/admin). A settings form is saved a handful of times. */
  consentSettingsWrite: {
    perUser: { limit: 20, windowMs: MIN },
    perOrg: { limit: 60, windowMs: MIN },
  },
  /**
   * GET/POST /notifications/unsubscribe (public, signed link). RFC 8058 one-click POSTs come from mail-provider
   * egress IPs shared by many recipients, so the per-IP cap is generous; it still bounds DB writes per source.
   */
  unsubscribe: { perIp: { limit: 120, windowMs: MIN } },
} as const satisfies Record<string, RouteLimit>;

export type RouteLimitScope = keyof typeof ROUTE_RATE_LIMITS;
export type RouteRateLimits = { readonly [K in RouteLimitScope]: RouteLimit };

export type RouteLimitSubject = {
  readonly organizationId?: string | null;
  readonly userId?: string | null;
  readonly ip?: string | null;
};

export type RouteLimiter = {
  /** Charges perIp, then perUser, then perOrg (whichever the scope defines). Throws 429 or 503. */
  charge(scope: RouteLimitScope, who: RouteLimitSubject): Promise<void>;
};

export function routeLimiter(
  rateLimiter: RateLimiter,
  overrides: Partial<RouteRateLimits> = {},
): RouteLimiter {
  const limits: RouteRateLimits = { ...ROUTE_RATE_LIMITS, ...overrides };
  return {
    async charge(scope, who) {
      const l = limits[scope];
      if (l.perIp)
        await consumeGuarded(rateLimiter, `rl:${scope}:ip:${clientIpKey(who.ip)}`, l.perIp);
      if (l.perUser) {
        if (!who.userId) throw new Error(`rate limit ${scope}: no caller`);
        // A caller without an organization (POST /orgs) keys on the user alone.
        const owner = who.organizationId ? `org:${who.organizationId}:` : '';
        await consumeGuarded(rateLimiter, `rl:${scope}:${owner}user:${who.userId}`, l.perUser);
      }
      if (l.perOrg) {
        if (!who.organizationId) throw new Error(`rate limit ${scope}: no organization`);
        await consumeGuarded(rateLimiter, `rl:${scope}:org:${who.organizationId}`, l.perOrg);
      }
    },
  };
}
