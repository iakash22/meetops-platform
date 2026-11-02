import {
  CALENDAR_PROVIDERS,
  INTEGRATION_STATE_TTL_SECONDS,
  type CalendarConnection,
  type CalendarEvent,
  type CalendarProviderId,
} from '@meetops/contracts';
import {
  CalendarProviderError,
  GoogleCalendarProvider,
  OutlookCalendarProvider,
  OAuthStateError,
  OAuthStateManager,
  type CalendarProvider,
} from '@meetops/integrations';
import { DomainError } from '../../shared/domain-error.js';
import { deriveExternalMeetingId, MeetingNotFoundError } from '../meetings/domain/meeting.js';
import {
  CallbackRejectedError,
  IntegrationNotConfiguredError,
  IntegrationsUnavailableError,
  OAuthStateInvalidError,
  ProviderUpstreamError,
} from '../integrations/errors.js';
import {
  putReturnTo,
  signState,
  takeReturnTo,
  verifySignedState,
  type IntegrationsRuntime,
} from '../integrations/runtime.js';
import { safeReturnUrl } from '../integrations/service.js';
import type {
  CalendarConnectionsRepository,
  CalendarEventLinkRow,
  CalendarEventLinksRepository,
  SyncedCalendarStore,
} from './ports.js';

export const CALENDAR_DEFAULT_RETURN_TO = '/calendar';
/** Synced events older than this are not served; the request falls back to a live provider read. */
export const CALENDAR_SYNC_FRESHNESS_MS = 30 * 60_000;
/** Refresh access tokens that expire within this window before using them. */
const REFRESH_SKEW_MS = 120_000;

export class CalendarConnectionNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Calendar connection not found', 404);
  }
}
export class CalendarEventLinkNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Calendar event link not found', 404);
  }
}
export class CalendarWindowError extends DomainError {
  constructor() {
    super('VALIDATION_FAILED', 'Invalid or too large calendar window (max 62 days)', 400);
  }
}

export type CalendarAuditFn = (
  action: 'calendar.connect' | 'calendar.disconnect' | 'calendar.link' | 'calendar.unlink',
  targetId: string,
  metadata?: Record<string, string>,
) => Promise<void>;

/**
 * Phase 7 calendar: connect (OAuth + PKCE, signed single-use state), callback, list events and disconnect. Providers
 * are compiled in (CALENDAR_PROVIDERS); their endpoints are fixed in @meetops/integrations and never come from a user.
 */
export class CalendarService {
  constructor(
    private readonly repo: CalendarConnectionsRepository,
    private readonly rt: IntegrationsRuntime | undefined,
    /** Read-through cache filled by the worker sync (off unless CALENDAR_SYNC_ENABLED=true). */
    private readonly synced?: SyncedCalendarStore,
    private readonly freshnessMs: number = CALENDAR_SYNC_FRESHNESS_MS,
    /** Event -> meeting links (P7). Without it events are never decorated and link routes answer 404. */
    private readonly links?: CalendarEventLinksRepository,
  ) {}

  /** Stored events when the last sync fully covers [from, to) and is fresh; null means "read live". */
  private async fromSync(
    organizationId: string,
    userId: string,
    c: CalendarConnection,
    from: Date,
    to: Date,
  ): Promise<CalendarEvent[] | null> {
    if (!this.synced) return null;
    try {
      const cov = await this.synced.coverage(organizationId, userId, c.id);
      const now = (this.rt?.now ?? Date.now)();
      if (
        !cov ||
        from < cov.from ||
        to > cov.to ||
        now - cov.lastSyncedAt.getTime() > this.freshnessMs
      )
        return null;
      const list = await this.synced.listEvents(organizationId, userId, c.id, from, to);
      return list.map((e) => ({ ...e, connectionId: c.id, provider: c.provider }));
    } catch {
      return null; // cache trouble never fails the request: fall back to the live read
    }
  }

  private runtime(): IntegrationsRuntime {
    if (!this.rt) throw new IntegrationsUnavailableError();
    return this.rt;
  }
  configured(provider: CalendarProviderId): boolean {
    if (provider === 'google') return Boolean(this.rt?.googleCalendar);
    if (provider === 'outlook') return Boolean(this.rt?.outlookCalendar);
    return false;
  }
  redirectUri(provider: CalendarProviderId) {
    return `${this.runtime().apiOrigin}/calendar/${provider}/callback`;
  }
  private provider(id: CalendarProviderId): CalendarProvider {
    const rt = this.runtime();
    if (id === 'outlook') {
      if (!rt.outlookCalendar)
        throw new IntegrationNotConfiguredError(
          'Outlook Calendar is not configured on this deployment',
        );
      return new OutlookCalendarProvider({
        clientId: rt.outlookCalendar.clientId,
        clientSecret: rt.outlookCalendar.clientSecret,
        ...(rt.outlookCalendar.tenant ? { tenant: rt.outlookCalendar.tenant } : {}),
        redirectUriAllowlist: [this.redirectUri('outlook')],
        stateStore: rt.stateStore,
        stateTtlSeconds: INTEGRATION_STATE_TTL_SECONDS,
        ...(rt.fetch ? { fetch: rt.fetch } : {}),
        ...(rt.now ? { now: rt.now } : {}),
      });
    }
    if (id !== 'google' || !rt.googleCalendar)
      throw new IntegrationNotConfiguredError(
        'Google Calendar is not configured on this deployment',
      );
    return new GoogleCalendarProvider({
      clientId: rt.googleCalendar.clientId,
      clientSecret: rt.googleCalendar.clientSecret,
      redirectUriAllowlist: [this.redirectUri('google')],
      stateStore: rt.stateStore,
      stateTtlSeconds: INTEGRATION_STATE_TTL_SECONDS,
      ...(rt.fetch ? { fetch: rt.fetch } : {}),
      ...(rt.now ? { now: rt.now } : {}),
    });
  }

  async providers(organizationId: string, userId: string) {
    const rows = await this.repo.listForUser(organizationId, userId);
    return CALENDAR_PROVIDERS.map((provider) => {
      const connection = rows.find((r) => r.provider === provider);
      return {
        provider,
        configured: this.configured(provider),
        ...(connection ? { connection } : {}),
      };
    });
  }

  async connect(input: {
    organizationId: string;
    userId: string;
    provider: CalendarProviderId;
    returnTo?: string;
  }): Promise<{ authorizeUrl: string }> {
    const rt = this.runtime();
    const begun = await this.provider(input.provider).beginAuthorization({
      organizationId: input.organizationId,
      userId: input.userId,
      redirectUri: this.redirectUri(input.provider),
    });
    if (input.returnTo)
      await putReturnTo(rt.stateStore, begun.state, input.returnTo, INTEGRATION_STATE_TTL_SECONDS);
    const url = new URL(begun.url);
    url.searchParams.set('state', signState(rt.stateSigningKey, begun.state));
    return { authorizeUrl: url.toString() };
  }

  verifyState(state: string): string {
    const inner = verifySignedState(this.runtime().stateSigningKey, state);
    if (!inner) throw new OAuthStateInvalidError();
    return inner;
  }

  async callback(input: {
    provider: CalendarProviderId;
    organizationId: string;
    userId: string;
    innerState: string;
    query: { code?: string | undefined; error?: string | undefined };
    audit: CalendarAuditFn;
  }): Promise<string> {
    const rt = this.runtime();
    const { provider, organizationId, userId, innerState, query } = input;
    const redirectUri = this.redirectUri(provider);
    const returnTo = (await takeReturnTo(rt.stateStore, innerState)) ?? CALENDAR_DEFAULT_RETURN_TO;
    const back = (status: 'connected' | 'denied') => {
      const u = safeReturnUrl(returnTo, rt.webOrigin);
      u.searchParams.set('calendar', provider);
      u.searchParams.set('status', status);
      return u.toString();
    };
    try {
      if (query.error) {
        await new OAuthStateManager(rt.stateStore, rt.now ? { now: rt.now } : {}).consume(
          innerState,
          { provider: `${provider}-calendar`, organizationId, userId, redirectUri },
        );
        return back('denied');
      }
      const done = await this.provider(provider).completeAuthorization({
        state: innerState,
        code: query.code,
        organizationId,
        userId,
        redirectUri,
      });
      const row = await this.repo.upsert(organizationId, {
        userId,
        provider,
        displayName: done.account.displayName,
        externalAccountId: done.account.externalAccountId,
        accessToken: done.accessToken,
        refreshToken: done.refreshToken,
        accessTokenExpiresAt: new Date(done.expiresAt),
      });
      await input.audit('calendar.connect', row.id, { provider });
      return back('connected');
    } catch (err) {
      throw mapCalendarError(err);
    }
  }

  /** Events across the user's active connections. A failing connection is marked `error` and skipped. */
  async events(input: {
    organizationId: string;
    userId: string;
    from: string;
    to: string;
  }): Promise<{ items: CalendarEvent[]; connections: CalendarConnection[] }> {
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (!(to > from) || to.getTime() - from.getTime() > 62 * 86_400_000)
      throw new CalendarWindowError();
    const connections = (await this.repo.listForUser(input.organizationId, input.userId)).filter(
      (c) => c.status !== 'revoked',
    );
    const items: CalendarEvent[] = [];
    for (const c of connections) {
      if (!this.configured(c.provider)) continue;
      const cached =
        c.status === 'active'
          ? await this.fromSync(input.organizationId, input.userId, c, from, to)
          : null;
      if (cached) {
        items.push(...cached);
        continue;
      }
      try {
        const token = await this.accessToken(input.organizationId, input.userId, c);
        if (!token) continue;
        const list = await this.provider(c.provider).listEvents({
          accessToken: token,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
        });
        for (const e of list) items.push({ ...e, connectionId: c.id, provider: c.provider });
      } catch (err) {
        if (err instanceof CalendarProviderError) {
          if (err.status === 401 || err.code === 'invalid_grant')
            await this.repo.markError(input.organizationId, c.id);
          continue;
        }
        throw err;
      }
    }
    items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    const page = items.slice(0, 500);
    return {
      items: await this.decorate(input.organizationId, input.userId, page, connections),
      connections,
    };
  }

  /**
   * Adds `meetingId` (stored link) and, for unlinked events with a conference URL, `suggestedMeetingId`: the one live
   * meeting of the org whose external call id equals the id meetings/resolve would derive from that URL. Read-only and
   * best effort: a link-store error returns the events undecorated.
   */
  private async decorate(
    organizationId: string,
    userId: string,
    items: CalendarEvent[],
    connections: CalendarConnection[],
  ): Promise<CalendarEvent[]> {
    if (!this.links || items.length === 0) return items;
    try {
      const linked = new Map(
        (
          await this.links.listForUser(
            organizationId,
            userId,
            connections.map((c) => c.id),
          )
        ).map((l) => [`${l.connectionId}\u0000${l.eventId}`, l.meetingId]),
      );
      const derived = new Map<CalendarEvent, string>();
      for (const e of items) {
        if (linked.has(`${e.connectionId}\u0000${e.id}`) || !e.conferenceUrl) continue;
        try {
          derived.set(e, deriveExternalMeetingId(e.conferenceUrl));
        } catch {
          // not a meeting host we resolve: no suggestion
        }
      }
      const matches = derived.size
        ? await this.links.matchExternalIds(organizationId, [...derived.values()])
        : new Map<string, string>();
      return items.map((e) => {
        const meetingId = linked.get(`${e.connectionId}\u0000${e.id}`);
        if (meetingId) return { ...e, meetingId };
        const ext = derived.get(e);
        const suggested = ext ? matches.get(ext) : undefined;
        return suggested ? { ...e, suggestedMeetingId: suggested } : e;
      });
    } catch {
      return items;
    }
  }

  /** The caller's own non-revoked connection, or 404 (unknown, other user's and revoked look the same). */
  private async ownConnection(organizationId: string, userId: string, connectionId: string) {
    const c = (await this.repo.listForUser(organizationId, userId)).find(
      (x) => x.id === connectionId && x.status !== 'revoked',
    );
    if (!c || !this.links) throw new CalendarConnectionNotFoundError();
    return { c, links: this.links };
  }

  /** Link one of my events to a meeting of this organization (re-linking replaces the meeting). */
  async link(
    input: {
      organizationId: string;
      userId: string;
      connectionId: string;
      eventId: string;
      meetingId: string;
    },
    audit: CalendarAuditFn,
  ): Promise<CalendarEventLinkRow> {
    const { links } = await this.ownConnection(
      input.organizationId,
      input.userId,
      input.connectionId,
    );
    const row = await links.upsert(input.organizationId, input.userId, {
      connectionId: input.connectionId,
      eventId: input.eventId,
      meetingId: input.meetingId,
    });
    if (!row) throw new MeetingNotFoundError();
    await audit('calendar.link', input.connectionId, { meetingId: input.meetingId });
    return row;
  }

  async unlink(
    input: { organizationId: string; userId: string; connectionId: string; eventId: string },
    audit: CalendarAuditFn,
  ): Promise<void> {
    const { links } = await this.ownConnection(
      input.organizationId,
      input.userId,
      input.connectionId,
    );
    if (
      !(await links.remove(input.organizationId, input.userId, input.connectionId, input.eventId))
    )
      throw new CalendarEventLinkNotFoundError();
    await audit('calendar.unlink', input.connectionId);
  }

  private async accessToken(organizationId: string, userId: string, c: CalendarConnection) {
    const s = await this.repo.readSecrets(organizationId, userId, c.id);
    if (!s) return null;
    const now = (this.rt?.now ?? Date.now)();
    if (s.accessTokenExpiresAt && s.accessTokenExpiresAt.getTime() - now > REFRESH_SKEW_MS)
      return s.accessToken;
    if (!s.refreshToken) return s.accessToken;
    const t = await this.provider(c.provider).refresh(s.refreshToken);
    await this.repo.updateTokens(organizationId, c.id, {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accessTokenExpiresAt: new Date(t.expiresAt),
    });
    return t.accessToken;
  }

  /** Revokes the grant at the provider (best effort: failures never block the local wipe), then wipes locally. */
  async disconnect(organizationId: string, userId: string, id: string, audit: CalendarAuditFn) {
    const secrets = await this.repo.readSecrets(organizationId, userId, id).catch(() => null);
    const conn = secrets
      ? (await this.repo.listForUser(organizationId, userId)).find((c) => c.id === id)
      : undefined;
    let providerRevoked = false;
    if (secrets && conn && this.configured(conn.provider)) {
      try {
        // Revoking the refresh token revokes the whole grant at Google.
        await this.provider(conn.provider).revoke(secrets.refreshToken ?? secrets.accessToken);
        providerRevoked = true;
      } catch {
        providerRevoked = false;
      }
    }
    if (!(await this.repo.revoke(organizationId, userId, id)))
      throw new CalendarConnectionNotFoundError();
    // Prisma deletes the links inside the revoke transaction. Other stores: delete here and let a failure surface
    // (never swallowed: a silent failure left links pointing at a revoked connection).
    if (!this.repo.revokesLinks) await this.links?.removeForConnection(organizationId, id);
    await audit('calendar.disconnect', id, { providerRevoked: String(providerRevoked) });
  }
}

export function mapCalendarError(err: unknown): unknown {
  if (err instanceof OAuthStateError) return new OAuthStateInvalidError();
  if (
    err instanceof CalendarProviderError &&
    (err.code === 'invalid_code' || err.code === 'missing_verifier')
  )
    return new CallbackRejectedError('Invalid authorization code');
  if (
    err instanceof CalendarProviderError &&
    (err.code === 'insufficient_scope' ||
      err.code === 'excess_scope' ||
      err.code === 'missing_refresh_token')
  )
    return new CallbackRejectedError('Calendar access was not fully granted');
  if (err instanceof CalendarProviderError) return new ProviderUpstreamError();
  return err;
}
