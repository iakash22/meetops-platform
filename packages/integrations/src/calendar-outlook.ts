import type { FetchLike } from './jira.js';
import {
  assertCalendarWindow,
  CALENDAR_MAX_EVENTS,
  CalendarProviderError,
  conferenceUrlOrUndefined,
  readCapped,
  type CalendarAccount,
  type CalendarEvent,
  type CalendarProvider,
  type CalendarTokens,
  type ListEventsInput,
} from './calendar.js';
import {
  assertAllowedRedirect,
  createPkcePair,
  OAuthStateManager,
  type OAuthStateStore,
} from './oauth-state.js';

/**
 * Phase 7: Microsoft Outlook (Microsoft Graph) calendar adapter. Same CalendarProvider contract as
 * GoogleCalendarProvider: fixed, compiled-in endpoints (login.microsoftonline.com + graph.microsoft.com), PKCE + signed
 * single-use state, read-only delegated scopes, sanitized errors, one timeout over request + body, 2 MiB body cap.
 */
export const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
export const MICROSOFT_GRAPH_API = 'https://graph.microsoft.com/v1.0';
const GRAPH_HOST = 'graph.microsoft.com';
/** Hosts allowed for the event's link back to Outlook (webLink). */
const OUTLOOK_HTML_HOSTS = ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'];

/** Read-only calendar + basic profile (account id / display name). Do not widen without Security review. */
export const OUTLOOK_CALENDAR_SCOPES = Object.freeze(['Calendars.Read', 'User.Read'] as const);
/** Requested alongside; offline_access is what yields a refresh token. */
export const OUTLOOK_IDENTITY_SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
] as const);
/**
 * Tenant segment of the Microsoft identity platform authority: `common` (work + personal), `organizations`,
 * `consumers`, a tenant GUID, or a verified domain of the tenant (e.g. `contoso.onmicrosoft.com`, `contoso.com`).
 * Domains: 2+ DNS labels (1-63 chars, alphanumeric with inner hyphens), alphabetic TLD, at most 253 chars.
 */
const TENANT_RE =
  /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i;

export class OutlookTenantError extends Error {
  override name = 'OutlookTenantError';
}

/** True for a tenant segment the provider accepts (see TENANT_RE). */
export function isValidOutlookTenant(tenant: string): boolean {
  return TENANT_RE.test(tenant);
}

/**
 * OUTLOOK_CALENDAR_TENANT at startup: unset/blank = undefined (provider default `common`); a valid tenant is
 * returned trimmed; anything else throws OutlookTenantError naming the key and the accepted forms (never the
 * value, which could be a mis-pasted secret).
 */
export function parseOutlookTenant(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (!TENANT_RE.test(t))
    throw new OutlookTenantError(
      'OUTLOOK_CALENDAR_TENANT must be common, organizations, consumers, a tenant GUID, or a verified ' +
        'tenant domain (e.g. contoso.onmicrosoft.com)',
    );
  return t;
}
const CODE_RE = /^[A-Za-z0-9._~/*!$-]{1,4096}$/;
/** Graph pages are followed at most this many times per listEvents (CALENDAR_MAX_EVENTS caps items anyway). */
const MAX_PAGES = 10;
const EVENT_SELECT =
  'id,subject,start,end,isAllDay,isCancelled,showAs,webLink,organizer,attendees,onlineMeeting,onlineMeetingUrl';

export interface OutlookCalendarOptions {
  clientId: string;
  /** Resolved per call from the secret manager; never stored on the instance. */
  clientSecret: () => Promise<string>;
  /** Azure AD tenant (default `common`). */
  tenant?: string;
  redirectUriAllowlist: readonly string[];
  stateStore: OAuthStateStore;
  stateTtlSeconds?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

/** Graph returns delegated scopes either short (`Calendars.Read`) or resource-qualified; normalize to short. */
function normalizeScope(s: string): string {
  return s.replace(/^https:\/\/graph\.microsoft\.com\//i, '');
}

export function assertReadOnlyOutlookScopes(scopes: readonly string[]): void {
  const lower = scopes.map((s) => normalizeScope(s).toLowerCase());
  if (!OUTLOOK_CALENDAR_SCOPES.every((s) => lower.includes(s.toLowerCase())))
    throw new CalendarProviderError('insufficient_scope');
  const allowed = [...OUTLOOK_CALENDAR_SCOPES, ...OUTLOOK_IDENTITY_SCOPES].map((s) =>
    s.toLowerCase(),
  );
  if (lower.some((s) => !allowed.includes(s))) throw new CalendarProviderError('excess_scope');
}

function outlookHtmlLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      OUTLOOK_HTML_HOSTS.includes(u.hostname.toLowerCase())
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Graph dateTimeTimeZone. We request `Prefer: outlook.timezone="UTC"`, so dateTime has no offset
 * (`2026-11-02T10:00:00.0000000`). Anything not in UTC is rejected rather than guessed.
 */
type GraphTime = { dateTime?: unknown; timeZone?: unknown };
function graphTime(t: GraphTime | undefined, allDay: boolean): string | null {
  if (!t || typeof t.dateTime !== 'string') return null;
  if (typeof t.timeZone === 'string' && t.timeZone.toUpperCase() !== 'UTC') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z)?$/.exec(t.dateTime);
  if (!m) return null;
  if (allDay) return `${m[1]}T00:00:00.000Z`;
  const d = new Date(`${m[1]}T${m[2]}${(m[3] ?? '').slice(0, 4)}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Maps one Graph event to the common CalendarEvent model (null = skipped). */
export function mapOutlookEvent(raw: unknown): CalendarEvent | null {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e.id !== 'string' || !e.id) return null;
  const allDay = e.isAllDay === true;
  const startsAt = graphTime(e.start as GraphTime, allDay);
  const endsAt = graphTime(e.end as GraphTime, allDay);
  if (!startsAt || !endsAt) return null;
  const status: CalendarEvent['status'] =
    e.isCancelled === true ? 'cancelled' : e.showAs === 'tentative' ? 'tentative' : 'confirmed';
  const conferenceUrl =
    conferenceUrlOrUndefined((e.onlineMeeting as { joinUrl?: unknown } | null)?.joinUrl) ??
    conferenceUrlOrUndefined(e.onlineMeetingUrl);
  const htmlLink = outlookHtmlLink(e.webLink);
  const organizer = (e.organizer as { emailAddress?: { address?: unknown } } | null)?.emailAddress
    ?.address;
  const ev: CalendarEvent = {
    id: e.id.slice(0, 1024),
    title:
      typeof e.subject === 'string' && e.subject.trim() ? e.subject.slice(0, 500) : '(no title)',
    startsAt,
    endsAt,
    allDay,
    attendeeCount: Array.isArray(e.attendees) ? e.attendees.length : 0,
    status,
  };
  if (conferenceUrl) ev.conferenceUrl = conferenceUrl;
  if (htmlLink) ev.htmlLink = htmlLink;
  if (typeof organizer === 'string' && organizer) ev.organizerEmail = organizer.slice(0, 320);
  return ev;
}

/** Graph throttling codes that mean "slow down", not "re-consent". */
const GRAPH_RATE_LIMIT_CODES = new Set([
  'TooManyRequests',
  'ApplicationThrottled',
  'activityLimitReached',
]);

/**
 * Maps an error body to a stable code. Token endpoint: OAuth `error` string (e.g. `invalid_grant`). Graph: `{ error:
 * { code } }` -> `rate_limited` on 429 / throttling codes, `sync_state_expired` for an expired delta token (410
 * `syncStateNotFound` / `resyncRequired`), else `http_error`. Messages and bodies are never kept.
 */
export function graphApiErrorCode(body: unknown, status: number): string {
  const e = (body as { error?: unknown } | undefined)?.error;
  if (typeof e === 'string' && /^[a-z_]{1,64}$/.test(e)) return e;
  const code = (e as { code?: unknown } | null | undefined)?.code;
  if (status === 429 || (typeof code === 'string' && GRAPH_RATE_LIMIT_CODES.has(code)))
    return 'rate_limited';
  if (
    status === 410 ||
    code === 'syncStateNotFound' ||
    code === 'resyncRequired' ||
    code === 'SyncStateNotFound'
  )
    return 'sync_state_expired';
  return 'http_error';
}

/** Result of one incremental (delta) read; `deltaLink` is the cursor to pass next time. */
export interface OutlookDeltaResult {
  events: CalendarEvent[];
  /** Ids Graph reported as removed (`@removed`) since the previous cursor. */
  removedIds: string[];
  deltaLink: string;
}

export class OutlookCalendarProvider implements CalendarProvider {
  readonly id = 'outlook' as const;
  private readonly state: OAuthStateManager;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly tenant: string;

  constructor(private readonly opts: OutlookCalendarOptions) {
    if (!opts.clientId) throw new Error('clientId is required');
    if (!opts.redirectUriAllowlist.length) throw new Error('redirectUriAllowlist is required');
    for (const r of opts.redirectUriAllowlist) assertAllowedRedirect(r, opts.redirectUriAllowlist);
    this.tenant = opts.tenant ?? 'common';
    if (!TENANT_RE.test(this.tenant)) throw new Error('invalid tenant');
    this.now = opts.now ?? Date.now;
    this.state = new OAuthStateManager(opts.stateStore, {
      ttlSeconds: opts.stateTtlSeconds ?? 600,
      now: this.now,
    });
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  get authorizeUrl() {
    return `${MICROSOFT_LOGIN_ORIGIN}/${this.tenant}/oauth2/v2.0/authorize`;
  }
  get tokenUrl() {
    return `${MICROSOFT_LOGIN_ORIGIN}/${this.tenant}/oauth2/v2.0/token`;
  }

  async beginAuthorization(input: { organizationId: string; userId: string; redirectUri: string }) {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    const pkce = createPkcePair();
    const state = await this.state.issue(
      { provider: 'outlook-calendar', ...input },
      pkce.codeVerifier,
    );
    const u = new URL(this.authorizeUrl);
    u.search = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: [...OUTLOOK_CALENDAR_SCOPES, 'offline_access'].join(' '),
      prompt: 'select_account',
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), state };
  }

  async completeAuthorization(input: {
    state: unknown;
    code: unknown;
    organizationId: string;
    userId: string;
    redirectUri: string;
  }) {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    const rec = await this.state.consume(input.state, {
      provider: 'outlook-calendar',
      organizationId: input.organizationId,
      userId: input.userId,
      redirectUri: input.redirectUri,
    });
    if (typeof input.code !== 'string' || !CODE_RE.test(input.code))
      throw new CalendarProviderError('invalid_code');
    if (!rec.codeVerifier) throw new CalendarProviderError('missing_verifier');
    const tokens = await this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: rec.redirectUri,
        code_verifier: rec.codeVerifier,
      },
      'connect',
    );
    if (!tokens.refreshToken) throw new CalendarProviderError('missing_refresh_token');
    const account = await this.me(tokens.accessToken);
    return { ...tokens, account };
  }

  /** Microsoft rotates refresh tokens: the new one is returned and MUST be stored (fenced save in callers). */
  async refresh(refreshToken: string): Promise<CalendarTokens> {
    if (!refreshToken) throw new CalendarProviderError('missing_refresh_token');
    const t = await this.tokenRequest(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: [...OUTLOOK_CALENDAR_SCOPES, 'offline_access'].join(' '),
      },
      'refresh',
    );
    return t.refreshToken ? t : { ...t, refreshToken };
  }

  /** Expanded occurrences in the window (`/me/calendarView`), ordered by start, capped at CALENDAR_MAX_EVENTS. */
  async listEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
    const { min, max } = assertCalendarWindow(input.timeMin, input.timeMax);
    const limit = Math.min(
      Math.max(1, input.maxResults ?? CALENDAR_MAX_EVENTS),
      CALENDAR_MAX_EVENTS,
    );
    const u = new URL(`${MICROSOFT_GRAPH_API}/me/calendarView`);
    u.search = new URLSearchParams({
      startDateTime: min.toISOString(),
      endDateTime: max.toISOString(),
      $orderby: 'start/dateTime',
      $top: String(Math.min(limit, 100)),
      $select: EVENT_SELECT,
    }).toString();
    const out: CalendarEvent[] = [];
    let next: string | undefined = u.toString();
    for (let page = 0; next && page < MAX_PAGES && out.length < limit; page++) {
      const body = (await this.graphGet(next, input.accessToken)) as {
        value?: unknown;
        '@odata.nextLink'?: unknown;
      };
      if (!body || !Array.isArray(body.value)) throw new CalendarProviderError('invalid_events');
      for (const raw of body.value) {
        const ev = mapOutlookEvent(raw);
        if (ev) out.push(ev);
      }
      next = this.graphLink(body['@odata.nextLink']);
    }
    return out.slice(0, limit);
  }

  /**
   * Incremental sync (`/me/calendarView/delta`). Without `deltaLink`, starts a new round for the window; with one,
   * returns only changes since it. Follows nextLinks to the final deltaLink. An expired cursor throws
   * CalendarProviderError('sync_state_expired'): restart with a full window. Not part of CalendarProvider (Google has
   * no equivalent wired yet); the windowed listEvents remains what the sync worker uses.
   */
  async listEventsDelta(input: {
    accessToken: string;
    timeMin?: string;
    timeMax?: string;
    deltaLink?: string;
  }): Promise<OutlookDeltaResult> {
    let next: string | undefined;
    if (input.deltaLink) {
      next = this.graphLink(input.deltaLink);
      if (!next) throw new CalendarProviderError('invalid_delta_link');
    } else {
      const { min, max } = assertCalendarWindow(input.timeMin ?? '', input.timeMax ?? '');
      const u = new URL(`${MICROSOFT_GRAPH_API}/me/calendarView/delta`);
      u.search = new URLSearchParams({
        startDateTime: min.toISOString(),
        endDateTime: max.toISOString(),
      }).toString();
      next = u.toString();
    }
    const events: CalendarEvent[] = [];
    const removedIds: string[] = [];
    for (let page = 0; page < MAX_PAGES * 5; page++) {
      const body = (await this.graphGet(next, input.accessToken, true)) as {
        value?: unknown;
        '@odata.nextLink'?: unknown;
        '@odata.deltaLink'?: unknown;
      };
      if (!body || !Array.isArray(body.value)) throw new CalendarProviderError('invalid_events');
      for (const raw of body.value) {
        const r = raw as { id?: unknown; '@removed'?: unknown } | null;
        if (r && r['@removed'] && typeof r.id === 'string') {
          removedIds.push(r.id.slice(0, 1024));
          continue;
        }
        const ev = mapOutlookEvent(raw);
        if (ev) events.push(ev);
      }
      if (events.length + removedIds.length > CALENDAR_MAX_EVENTS * 20)
        throw new CalendarProviderError('too_many_changes');
      const delta = this.graphLink(body['@odata.deltaLink']);
      if (delta) return { events, removedIds, deltaLink: delta };
      const n = this.graphLink(body['@odata.nextLink']);
      if (!n) throw new CalendarProviderError('invalid_delta_response');
      next = n;
    }
    throw new CalendarProviderError('too_many_pages');
  }

  /**
   * Microsoft identity has no per-token revocation endpoint (only revokeSignInSessions, which signs the user out
   * everywhere and needs a write scope). Disconnect therefore deletes our stored tokens; the user removes the app
   * grant at https://myapps.microsoft.com (or the tenant admin in Entra ID). No-op by design.
   */
  async revoke(token: string): Promise<void> {
    void token;
  }

  /** Only https links on graph.microsoft.com /v1.0 are followed (never a host from a response). */
  private graphLink(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    try {
      const u = new URL(v);
      if (
        u.protocol !== 'https:' ||
        u.hostname.toLowerCase() !== GRAPH_HOST ||
        u.port ||
        u.username ||
        u.password ||
        !u.pathname.startsWith('/v1.0/me/calendarView')
      )
        return undefined;
      return u.toString();
    } catch {
      return undefined;
    }
  }

  private graphGet(url: string, accessToken: string, delta = false) {
    return this.call(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        Prefer: delta ? 'outlook.timezone="UTC", odata.maxpagesize=100' : 'outlook.timezone="UTC"',
      },
    });
  }

  private async me(accessToken: string): Promise<CalendarAccount> {
    const b = (await this.call(
      `${MICROSOFT_GRAPH_API}/me?$select=id,displayName,mail,userPrincipalName`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      },
    )) as { id?: unknown; displayName?: unknown; mail?: unknown; userPrincipalName?: unknown };
    if (typeof b?.id !== 'string' || !b.id.trim())
      throw new CalendarProviderError('invalid_account');
    const name = [b.mail, b.userPrincipalName, b.displayName].find(
      (x): x is string => typeof x === 'string' && !!x.trim(),
    );
    return {
      externalAccountId: b.id.slice(0, 320),
      displayName: (name ?? b.id).slice(0, 200),
    };
  }

  private async tokenRequest(
    params: Record<string, string>,
    phase: 'connect' | 'refresh',
  ): Promise<CalendarTokens> {
    const b = (await this.call(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        ...params,
        client_id: this.opts.clientId,
        client_secret: await this.opts.clientSecret(),
      }).toString(),
    })) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
      token_type?: unknown;
    };
    if (typeof b?.access_token !== 'string' || !b.access_token)
      throw new CalendarProviderError('invalid_token_response');
    if (typeof b.token_type === 'string' && b.token_type.toLowerCase() !== 'bearer')
      throw new CalendarProviderError('invalid_token_type');
    const scopeOmitted = phase === 'refresh' && typeof b.scope !== 'string';
    const scopes = scopeOmitted
      ? [...OUTLOOK_CALENDAR_SCOPES]
      : (typeof b.scope === 'string' ? b.scope.split(/\s+/) : [])
          .filter(Boolean)
          .map(normalizeScope);
    // No revoke on refusal: Microsoft has no token revocation endpoint (see revoke()); the grant is simply not kept.
    assertReadOnlyOutlookScopes(scopes);
    const expiresIn =
      typeof b.expires_in === 'number' && b.expires_in > 0
        ? b.expires_in
        : typeof b.expires_in === 'string' && /^\d{1,6}$/.test(b.expires_in)
          ? Number(b.expires_in)
          : 3600;
    return {
      accessToken: b.access_token,
      refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : '',
      expiresAt: this.now() + expiresIn * 1000,
      scopes: [...new Set(scopes)].sort(),
    };
  }

  /** Same transport rules as GoogleCalendarProvider: no retries, no redirects, sanitized errors, capped body. */
  private async call(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const ms = this.opts.timeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CalendarProviderError('timeout'));
      }, ms);
    });
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await Promise.race([
          this.fetchFn(url, { ...init, redirect: 'error', signal: controller.signal }),
          timeout,
        ]);
      } catch (err) {
        if (err instanceof CalendarProviderError) throw err;
        throw new CalendarProviderError(
          (err as { name?: string }).name === 'AbortError' ? 'timeout' : 'network_error',
        );
      }
      const text = await Promise.race([readCapped(res, controller), timeout]);
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        throw new CalendarProviderError('invalid_json', res.status);
      }
      if (!res.ok) throw new CalendarProviderError(graphApiErrorCode(json, res.status), res.status);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}
