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

function httpsOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
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
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: rec.redirectUri,
      code_verifier: rec.codeVerifier,
    });
    if (!tokens.refreshToken) throw new CalendarProviderError('missing_refresh_token');
    const account = await this.primaryCalendar(tokens.accessToken);
    return { ...tokens, account };
  }

  async refresh(refreshToken: string): Promise<CalendarTokens> {
    if (!refreshToken) throw new CalendarProviderError('missing_refresh_token');
    const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
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
      const conferenceUrl = httpsOrUndefined(entry?.uri ?? e.hangoutLink);
      const htmlLink = httpsOrUndefined(e.htmlLink);
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

  private async tokenRequest(params: Record<string, string>): Promise<CalendarTokens> {
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
    const scopes = (typeof b.scope === 'string' ? b.scope.split(/\s+/) : []).filter(Boolean);
    if (!GOOGLE_CALENDAR_SCOPES.every((s) => scopes.includes(s)))
      throw new CalendarProviderError('insufficient_scope');
    const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
    return {
      accessToken: b.access_token,
      refreshToken: typeof b.refresh_token === 'string' ? b.refresh_token : '',
      expiresAt: this.now() + expiresIn * 1000,
      scopes: [...new Set(scopes)].sort(),
    };
  }

  /** No retries (codes are single-use), no redirects, timeout, sanitized errors. */
  private async call(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(url, { ...init, redirect: 'error', signal: controller.signal });
    } catch (err) {
      throw new CalendarProviderError(
        (err as { name?: string }).name === 'AbortError' ? 'timeout' : 'network_error',
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    if (text.length > 2 * 1024 * 1024)
      throw new CalendarProviderError('response_too_large', res.status);
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
  }
}
