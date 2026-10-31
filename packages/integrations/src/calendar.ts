import { isAllowedConferenceUrl } from '@meetops/contracts/types';
import type { FetchLike } from './jira.js';
import {
  assertAllowedRedirect,
  createPkcePair,
  OAuthStateManager,
  type OAuthStateStore,
} from './oauth-state.js';

/**
 * Phase 7: provider-agnostic calendar adapter. Every provider talks to fixed, compiled-in endpoints only; no
 * caller-supplied base URL exists anywhere in this interface (users can never point the server at an arbitrary host).
 */
export type CalendarProviderId = 'google';

export interface CalendarTokens {
  accessToken: string;
  /** Empty string when the provider did not return one (refresh keeps the previous token). */
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

export interface CalendarAccount {
  /** Stable provider account id (Google: primary calendar id / account email). */
  externalAccountId: string;
  displayName: string;
}

export interface CalendarEvent {
  /** Provider event id. */
  id: string;
  title: string;
  /** ISO-8601. All-day events start at 00:00Z of the date. */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** Video-conference join link when the provider exposes one (https only). */
  conferenceUrl?: string;
  /** https link to the event in the provider UI. */
  htmlLink?: string;
  organizerEmail?: string;
  attendeeCount: number;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface ListEventsInput {
  accessToken: string;
  /** ISO-8601, inclusive. */
  timeMin: string;
  /** ISO-8601, exclusive. Window is capped at CALENDAR_MAX_WINDOW_DAYS. */
  timeMax: string;
  maxResults?: number;
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  beginAuthorization(input: {
    organizationId: string;
    userId: string;
    redirectUri: string;
  }): Promise<{ url: string; state: string }>;
  completeAuthorization(input: {
    state: unknown;
    code: unknown;
    organizationId: string;
    userId: string;
    redirectUri: string;
  }): Promise<CalendarTokens & { account: CalendarAccount }>;
  refresh(refreshToken: string): Promise<CalendarTokens>;
  listEvents(input: ListEventsInput): Promise<CalendarEvent[]>;
  /** Revoke a token at the provider (best effort for callers; throws CalendarProviderError on failure). */
  revoke(token: string): Promise<void>;
}

export class CalendarProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    // Never include tokens, codes, client secrets or upstream bodies.
    super(`Calendar provider failed: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'CalendarProviderError';
  }
}

export const CALENDAR_MAX_WINDOW_DAYS = 62;
export const CALENDAR_MAX_EVENTS = 250;

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const CALENDAR_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Hosts allowed for the event's link back to the provider UI. */
const GOOGLE_HTML_HOSTS = ['calendar.google.com', 'www.google.com'];
/** Read-only events + identity of the primary calendar. Do not widen without Security review. */
export const GOOGLE_CALENDAR_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const);

export interface GoogleCalendarOptions {
  clientId: string;
  /** Resolved per call from the secret manager; never stored on the instance. */
  clientSecret: () => Promise<string>;
  redirectUriAllowlist: readonly string[];
  stateStore: OAuthStateStore;
  stateTtlSeconds?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

const CODE_RE = /^[A-Za-z0-9._~/-]{1,2048}$/;

function googleHtmlLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      GOOGLE_HTML_HOSTS.includes(u.hostname.toLowerCase())
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Join links only on allowlisted conference hosts (Meet, Zoom incl. subdomains and zoomgov, Teams); others dropped. */
export function conferenceUrlOrUndefined(v: unknown): string | undefined {
  return isAllowedConferenceUrl(v) ? new URL(v).toString() : undefined;
}

/** Any granted Google Calendar scope outside the read-only set (e.g. calendar, calendar.events) is refused. */
/** Identity scopes Google may add to a grant; harmless and tolerated. */
export const GOOGLE_IDENTITY_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const);

/** Upper bound for a revoke call (best effort; never holds up a disconnect or a rejected callback). */
export const CALENDAR_REVOKE_TIMEOUT_MS = 3000;

export function assertReadOnlyCalendarScopes(scopes: readonly string[]): void {
  if (!GOOGLE_CALENDAR_SCOPES.every((s) => scopes.includes(s)))
    throw new CalendarProviderError('insufficient_scope');
  // Only the read-only calendar scopes plus basic identity are accepted; any other grant (calendar write, Gmail,
  // Drive, ...) is excess and the whole grant is rejected.
  const allowed: readonly string[] = [...GOOGLE_CALENDAR_SCOPES, ...GOOGLE_IDENTITY_SCOPES];
  if (scopes.some((s) => !allowed.includes(s))) throw new CalendarProviderError('excess_scope');
}

/** Validates and normalizes a list window; throws CalendarProviderError('invalid_window'). */
export function assertCalendarWindow(timeMin: string, timeMax: string): { min: Date; max: Date } {
  const min = new Date(timeMin);
  const max = new Date(timeMax);
  if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime()) || max <= min)
    throw new CalendarProviderError('invalid_window');
  if (max.getTime() - min.getTime() > CALENDAR_MAX_WINDOW_DAYS * 86_400_000)
    throw new CalendarProviderError('window_too_large');
  return { min, max };
}

type GoogleTime = { dateTime?: unknown; date?: unknown };
function googleTime(t: GoogleTime | undefined): { iso: string; allDay: boolean } | null {
  if (!t) return null;
  if (typeof t.dateTime === 'string') {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : { iso: d.toISOString(), allDay: false };
  }
  if (typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date))
    return { iso: `${t.date}T00:00:00.000Z`, allDay: true };
  return null;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = 'google' as const;
  private readonly state: OAuthStateManager;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: GoogleCalendarOptions) {
    if (!opts.clientId) throw new Error('clientId is required');
    if (!opts.redirectUriAllowlist.length) throw new Error('redirectUriAllowlist is required');
    for (const r of opts.redirectUriAllowlist) assertAllowedRedirect(r, opts.redirectUriAllowlist);
    this.now = opts.now ?? Date.now;
    this.state = new OAuthStateManager(opts.stateStore, {
      ttlSeconds: opts.stateTtlSeconds ?? 600,
      now: this.now,
    });
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async beginAuthorization(input: { organizationId: string; userId: string; redirectUri: string }) {
    assertAllowedRedirect(input.redirectUri, this.opts.redirectUriAllowlist);
    const pkce = createPkcePair();
    const state = await this.state.issue(
      { provider: 'google-calendar', ...input },
      pkce.codeVerifier,
    );
    const u = new URL(GOOGLE_AUTHORIZE_URL);
    u.search = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'false',
      prompt: 'consent',
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
      provider: 'google-calendar',
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
    const account = await this.primaryCalendar(tokens.accessToken);
    return { ...tokens, account };
  }

  async refresh(refreshToken: string): Promise<CalendarTokens> {
    if (!refreshToken) throw new CalendarProviderError('missing_refresh_token');
    const t = await this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'refresh',
    );
    // Google normally keeps the refresh token; keep the old one when none is returned.
    return t.refreshToken ? t : { ...t, refreshToken };
  }

  async listEvents(input: ListEventsInput): Promise<CalendarEvent[]> {
    const { min, max } = assertCalendarWindow(input.timeMin, input.timeMax);
    const limit = Math.min(
      Math.max(1, input.maxResults ?? CALENDAR_MAX_EVENTS),
      CALENDAR_MAX_EVENTS,
    );
    const u = new URL(`${GOOGLE_CALENDAR_API}/calendars/primary/events`);
    u.search = new URLSearchParams({
      timeMin: min.toISOString(),
      timeMax: max.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(limit),
    }).toString();
    const body = (await this.call(u.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.accessToken}`, Accept: 'application/json' },
    })) as { items?: unknown };
    if (!body || !Array.isArray(body.items)) throw new CalendarProviderError('invalid_events');
    return body.items.flatMap((raw): CalendarEvent[] => {
      const e = raw as Record<string, unknown>;
      if (typeof e.id !== 'string' || !e.id) return [];
      const start = googleTime(e.start as GoogleTime);
      const end = googleTime(e.end as GoogleTime);
      if (!start || !end) return [];
      const status = e.status === 'tentative' || e.status === 'cancelled' ? e.status : 'confirmed';
      const entry = (
        e.conferenceData as
          { entryPoints?: { entryPointType?: unknown; uri?: unknown }[] } | undefined
      )?.entryPoints?.find((p) => p?.entryPointType === 'video');
      const conferenceUrl =
        conferenceUrlOrUndefined(entry?.uri) ?? conferenceUrlOrUndefined(e.hangoutLink);
      const htmlLink = googleHtmlLink(e.htmlLink);
      const organizer = (e.organizer as { email?: unknown } | undefined)?.email;
      const ev: CalendarEvent = {
        id: e.id.slice(0, 1024),
        title:
          typeof e.summary === 'string' && e.summary.trim()
            ? e.summary.slice(0, 500)
            : '(no title)',
        startsAt: start.iso,
        endsAt: end.iso,
        allDay: start.allDay,
        attendeeCount: Array.isArray(e.attendees) ? e.attendees.length : 0,
        status,
      };
      if (conferenceUrl) ev.conferenceUrl = conferenceUrl;
      if (htmlLink) ev.htmlLink = htmlLink;
      if (typeof organizer === 'string') ev.organizerEmail = organizer.slice(0, 320);
      return [ev];
    });
  }

  async revoke(token: string): Promise<void> {
    if (!token) return;
    await this.call(
      GOOGLE_REVOKE_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      },
      Math.min(this.opts.timeoutMs ?? CALENDAR_REVOKE_TIMEOUT_MS, CALENDAR_REVOKE_TIMEOUT_MS),
    );
  }

  private async primaryCalendar(accessToken: string): Promise<CalendarAccount> {
    const b = (await this.call(`${GOOGLE_CALENDAR_API}/users/me/calendarList/primary`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })) as { id?: unknown; summary?: unknown };
    if (typeof b?.id !== 'string' || !b.id.trim())
      throw new CalendarProviderError('invalid_account');
    return {
      externalAccountId: b.id.slice(0, 320),
      displayName:
        typeof b.summary === 'string' && b.summary.trim()
          ? b.summary.slice(0, 200)
          : b.id.slice(0, 200),
    };
  }

  private async tokenRequest(
    params: Record<string, string>,
    phase: 'connect' | 'refresh',
  ): Promise<CalendarTokens> {
    const body = await this.call(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        ...params,
        client_id: this.opts.clientId,
        client_secret: await this.opts.clientSecret(),
      }).toString(),
    });
    const b = body as {
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
    // RFC 6749 s5.1: on refresh an omitted `scope` means "same as originally granted" (already checked at connect).
    const scopeOmitted = phase === 'refresh' && typeof b.scope !== 'string';
    const scopes = scopeOmitted
      ? [...GOOGLE_CALENDAR_SCOPES]
      : (typeof b.scope === 'string' ? b.scope.split(/\s+/) : []).filter(Boolean);
    try {
      assertReadOnlyCalendarScopes(scopes);
    } catch (err) {
      // Never keep (or leave live at Google) a grant we refuse. Revoke (best effort) on any refusal during the
      // initial connect, but on refresh only for excess scope: a narrower/odd refresh response must not kill the
      // user's existing read-only grant (#317 L-1).
      const excess = err instanceof CalendarProviderError && err.code === 'excess_scope';
      if (phase === 'connect' || excess) {
        const grant =
          typeof b.refresh_token === 'string' && b.refresh_token ? b.refresh_token : b.access_token;
        await this.revoke(grant).catch(() => undefined);
      }
      throw err;
    }
    const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
    return {
      accessToken: b.access_token,
      refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : '',
      expiresAt: this.now() + expiresIn * 1000,
      scopes: [...new Set(scopes)].sort(),
    };
  }

  /**
   * No retries (codes are single-use), no redirects, sanitized errors. One timeout covers the request AND reading the
   * body; the 2 MiB cap is enforced while streaming (and checked again for non-streaming fetch stand-ins).
   */
  private async call(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    timeoutMs?: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const ms = timeoutMs ?? this.opts.timeoutMs ?? 10_000;
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
      if (!res.ok) {
        const e = (json as { error?: unknown } | undefined)?.error;
        throw new CalendarProviderError(
          typeof e === 'string' && /^[a-z_]{1,64}$/.test(e) ? e : 'http_error',
          res.status,
        );
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

type StreamingBody = {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
};

/** Reads the body, aborting as soon as it exceeds CALENDAR_MAX_RESPONSE_BYTES. */
async function readCapped(
  res: Awaited<ReturnType<FetchLike>>,
  controller: AbortController,
): Promise<string> {
  const body = (res as { body?: unknown }).body as StreamingBody | null | undefined;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > CALENDAR_MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new CalendarProviderError('response_too_large', res.status);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text().catch(() => '');
  if (Buffer.byteLength(text, 'utf8') > CALENDAR_MAX_RESPONSE_BYTES)
    throw new CalendarProviderError('response_too_large', res.status);
  return text;
}
