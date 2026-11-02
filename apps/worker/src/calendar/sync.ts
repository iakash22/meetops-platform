import type { CalendarSyncEventInput, CalendarSyncSecrets } from '@meetops/database';
import { deriveExternalMeetingIdResult } from '@meetops/integrations';

/**
 * Phase 7 calendar background sync (modelled on integrations/token-refresh.ts). Off by default
 * (CALENDAR_SYNC_ENABLED=true opts in;
 * CALENDAR_SYNC_DELTA_ENABLED=true additionally uses provider delta sync, Outlook today). Each sweep pulls a rolling window of events for every due, active calendar
 * connection, upserts them, soft-cancels events that vanished from a complete provider list, and advances the
 * per-connection cursor. Permanent auth failures mark the connection `error` (the UI asks for a reconnect);
 * transient failures (429, 5xx, network) back off exponentially per connection. Only identifiers, counts and error
 * names/codes are logged, never token material or event content.
 */

/** Repository surface (createCalendarSyncRepository from @meetops/database with the encrypting cipher). */
export interface CalendarSyncSweepRepository {
  listDueForSync(
    now: Date,
    limit?: number,
  ): Promise<{ organizationId: string; id: string; userId: string; provider: string }[]>;
  /**
   * Atomic claim timed by the database clock (one replica wins); null = another sweep holds it or it is not due.
   * `lease` is the claim token passed back to applySync/recordFailure, which refuse to write once it is lost.
   */
  claimForSync(
    organizationId: string,
    id: string,
    leaseMs: number,
  ): Promise<{ lease: Date } | null>;
  readSecrets(organizationId: string, id: string): Promise<CalendarSyncSecrets | null>;
  updateTokens(
    organizationId: string,
    id: string,
    t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
  ): Promise<void>;
  /** With `lease`, writes only while the claim is still held. */
  markError(organizationId: string, id: string, opts?: { lease?: Date }): Promise<unknown>;
  recordFailure(
    organizationId: string,
    id: string,
    s: { syncFailures: number; retryInMs: number; lease: Date },
  ): Promise<boolean>;
  applySync(
    organizationId: string,
    input: {
      connectionId: string;
      from: Date;
      to: Date;
      events: CalendarSyncEventInput[];
      complete: boolean;
      now: Date;
      nextSyncInMs: number;
      lease: Date;
      removedIds?: string[];
      /** undefined = keep the stored cursor, null = clear it, string = store it for [from, to). */
      cursor?: string | null;
      /** Auto-link candidates (event id -> derived externalMeetingId); only sent when auto-link is enabled. */
      autoLink?: { eventId: string; externalMeetingId: string }[];
    },
  ): Promise<{ upserted: number; cancelled: number; applied: boolean; autoLinked?: number }>;
}

/** Provider calls (GoogleCalendarProvider in prod), injected so the sweep stays fetch/SDK agnostic. */
export interface CalendarSyncProvider {
  refresh(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>;
  listEvents(input: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
  }): Promise<CalendarSyncEventInput[]>;
  /**
   * Optional incremental sync (Outlook calendarView delta). Without `cursor` it opens a new round for
   * [timeMin, timeMax) and returns the complete window plus a cursor; with one it returns only the changes since
   * (upserts + removed ids). An expired cursor throws code `sync_state_expired` (the sweep then starts a new round).
   * Providers without it (Google today) use the windowed listEvents.
   */
  listEventsDelta?(input: {
    accessToken: string;
    timeMin: string;
    timeMax: string;
    cursor?: string;
  }): Promise<{ events: CalendarSyncEventInput[]; removedIds: string[]; cursor: string }>;
}

export interface CalendarSyncLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface CalendarSyncConfig {
  /** Sync cadence for a healthy connection. */
  intervalMs: number;
  /** Window = [now - pastMs, now + futureMs); capped at CALENDAR_SYNC_MAX_WINDOW_MS. */
  pastMs: number;
  futureMs: number;
  /** Max backoff after repeated transient failures. */
  maxBackoffMs: number;
  /** Connections per sweep. */
  limit: number;
  /** Provider page cap; a list this long is treated as truncated (no cancellations). */
  maxEvents: number;
  /** Max connections of one organization per sweep (per-org fairness: one big tenant cannot starve the rest). */
  perOrgLimit: number;
  /** Use provider delta sync when available (CALENDAR_SYNC_DELTA_ENABLED, default off). */
  deltaEnabled: boolean;
  /** A delta round is restarted once its window's end lags the rolling window's end by more than this. */
  cursorMaxLagMs: number;
  /**
   * CALENDAR_AUTO_LINK_ENABLED (default off): store a link for each synced event whose conference URL matches
   * exactly one live meeting of the org. Never overwrites or recreates an existing or user-removed link.
   */
  autoLinkEnabled: boolean;
}

export interface CalendarSyncDeps {
  repo: CalendarSyncSweepRepository;
  providers: Partial<Record<string, CalendarSyncProvider>>;
  log: CalendarSyncLog;
  config?: Partial<CalendarSyncConfig>;
  now?: () => number;
  /** Jitter source in [0, 1) (default Math.random); injected in tests. */
  random?: () => number;
}

export interface CalendarSyncResult {
  synced: number;
  failed: number;
  skipped: number;
  upserted: number;
  cancelled: number;
  autoLinked: number;
}

const DAY = 86_400_000;
/** Mirrors CALENDAR_MAX_WINDOW_DAYS (62) in @meetops/integrations. */
export const CALENDAR_SYNC_MAX_WINDOW_MS = 62 * DAY;
export const CALENDAR_SYNC_DEFAULTS: CalendarSyncConfig = {
  intervalMs: 15 * 60_000,
  pastMs: 1 * DAY,
  futureMs: 30 * DAY,
  maxBackoffMs: 6 * 3_600_000,
  limit: 50,
  maxEvents: 250,
  perOrgLimit: 10,
  deltaEnabled: false,
  cursorMaxLagMs: 1 * DAY,
  autoLinkEnabled: false,
};

/** Fetch headroom so round-robin selection can reach orgs queued behind one large tenant. */
const DUE_FETCH_FACTOR = 4;

/**
 * Per-org fair pick: round-robin across organizations in due order (first-seen org first), at most `perOrg` each,
 * `limit` total. Connections left out stay due (they were never claimed) and are picked on a later tick.
 */
export function selectFairly<T extends { organizationId: string }>(
  due: T[],
  limit: number,
  perOrg: number,
): T[] {
  const groups = new Map<string, T[]>();
  for (const d of due) {
    const g = groups.get(d.organizationId);
    if (g) g.push(d);
    else groups.set(d.organizationId, [d]);
  }
  const out: T[] = [];
  for (let round = 0; round < perOrg && out.length < limit; round++) {
    let any = false;
    for (const g of groups.values()) {
      const d = g[round];
      if (!d) continue;
      any = true;
      out.push(d);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

/**
 * Events that can be auto-linked: not cancelled, with a conference URL on a supported meeting host. The id is derived
 * exactly as meetings/resolve and the API's suggestedMeetingId do (shared @meetops/integrations helper); the
 * one-live-meeting match itself happens in the repository transaction.
 */
export function autoLinkCandidates(
  events: CalendarSyncEventInput[],
): { eventId: string; externalMeetingId: string }[] {
  const out: { eventId: string; externalMeetingId: string }[] = [];
  for (const e of events) {
    if (e.status === 'cancelled' || !e.conferenceUrl) continue;
    const r = deriveExternalMeetingIdResult(e.conferenceUrl);
    if (r.ok) out.push({ eventId: e.id, externalMeetingId: r.id });
  }
  return out;
}

const isCursorExpired = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'sync_state_expired' || code === 'invalid_delta_link';
};
/** How long a claim holds a connection before another sweep may take it (crash recovery). */
export const CALENDAR_SYNC_LEASE_MS = 10 * 60_000;
/** Refresh access tokens expiring within this window before using them (same skew as the API). */
const REFRESH_SKEW_MS = 120_000;

/** Grant gone (re-consent needed) as opposed to a transient upstream failure. */
export function isPermanentCalendarError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;
  // Google answers quota exhaustion (rateLimitExceeded / userRateLimitExceeded) with 403: back off, keep the grant.
  if (code === 'rate_limited' || code === 'rate_limit_exceeded') return false;
  return (
    code === 'invalid_grant' ||
    code === 'missing_refresh_token' ||
    code === 'insufficient_scope' ||
    status === 401 ||
    status === 403
  );
}

/**
 * Exponential backoff from the interval: interval * 2^(failures-1), capped, then jittered to 80-120% (`random` in
 * [0, 1)) so connections that failed together (e.g. a provider outage) do not retry in lockstep.
 */
export function calendarSyncBackoffMs(
  failures: number,
  cfg: CalendarSyncConfig,
  random: () => number = Math.random,
): number {
  const n = Math.min(Math.max(failures, 1), 20);
  const base = Math.min(cfg.intervalMs * 2 ** (n - 1), cfg.maxBackoffMs);
  return Math.round(base * (0.8 + 0.4 * clamp01(random())));
}

/** Healthy cadence with up to +10% jitter, so syncs spread out instead of bunching on the same tick. */
export function calendarSyncNextMs(cfg: CalendarSyncConfig, random: () => number = Math.random) {
  return Math.round(cfg.intervalMs * (1 + 0.1 * clamp01(random())));
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(Math.max(x, 0), 0.999999) : 0.5);

function errInfo(err: unknown) {
  const e = err as { name?: unknown; code?: unknown; status?: unknown } | null;
  return {
    errName: err instanceof Error ? err.name : 'unknown',
    ...(typeof e?.code === 'string' ? { errCode: e.code.slice(0, 64) } : {}),
    ...(typeof e?.status === 'number' ? { errStatus: e.status } : {}),
  };
}

export async function runCalendarSyncSweep(deps: CalendarSyncDeps): Promise<CalendarSyncResult> {
  const cfg: CalendarSyncConfig = { ...CALENDAR_SYNC_DEFAULTS, ...deps.config };
  const clock = deps.now ?? Date.now;
  const span = Math.min(cfg.pastMs + cfg.futureMs, CALENDAR_SYNC_MAX_WINDOW_MS);
  const fetched = await deps.repo.listDueForSync(
    new Date(clock()),
    Math.min(cfg.limit * DUE_FETCH_FACTOR, 2000),
  );
  const due = selectFairly(fetched, cfg.limit, Math.max(1, cfg.perOrgLimit));
  const result: CalendarSyncResult = {
    synced: 0,
    failed: 0,
    skipped: 0,
    upserted: 0,
    cancelled: 0,
    autoLinked: 0,
  };

  for (const d of due) {
    const ids = { organizationId: d.organizationId, connectionId: d.id, provider: d.provider };
    const provider = deps.providers[d.provider];
    if (!provider) {
      result.skipped++;
      continue;
    }
    let failures = 0;
    let lease: Date | undefined;
    try {
      // Claimed per connection at the database's current time, never the sweep's start: a connection reached late
      // in a long sweep gets a full lease, and one that another sweep holds stays skipped.
      lease = (await deps.repo.claimForSync(d.organizationId, d.id, CALENDAR_SYNC_LEASE_MS))?.lease;
      if (!lease) {
        result.skipped++;
        continue;
      }
      const nowMs = clock();
      const now = new Date(nowMs);
      const from = new Date(nowMs - Math.min(cfg.pastMs, span));
      const to = new Date(from.getTime() + span);
      const s = await deps.repo.readSecrets(d.organizationId, d.id);
      if (!s) {
        result.skipped++;
        continue;
      }
      failures = s.syncFailures;
      let accessToken = s.accessToken;
      const expiring =
        !s.accessTokenExpiresAt || s.accessTokenExpiresAt.getTime() - nowMs <= REFRESH_SKEW_MS;
      if (expiring && s.refreshToken) {
        const t = await provider.refresh(s.refreshToken);
        await deps.repo.updateTokens(d.organizationId, d.id, {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          accessTokenExpiresAt: new Date(t.expiresAt),
        });
        accessToken = t.accessToken;
      }
      const listDelta = cfg.deltaEnabled ? provider.listEventsDelta?.bind(provider) : undefined;
      let plan: {
        from: Date;
        to: Date;
        events: CalendarSyncEventInput[];
        complete: boolean;
        removedIds?: string[];
        cursor?: string | null;
      };
      if (listDelta) {
        const c = s.syncCursor;
        const fresh = async () => {
          const r = await listDelta({
            accessToken,
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
          });
          // A new round returns the whole window, so vanished events are cancelled like a complete list.
          return { from, to, events: r.events, complete: true, cursor: r.cursor };
        };
        if (c && to.getTime() - c.to.getTime() <= cfg.cursorMaxLagMs) {
          try {
            const r = await listDelta({
              accessToken,
              timeMin: c.from.toISOString(),
              timeMax: c.to.toISOString(),
              cursor: c.value,
            });
            plan = {
              from: c.from,
              to: c.to,
              events: r.events,
              complete: false,
              removedIds: r.removedIds,
              cursor: r.cursor,
            };
          } catch (err) {
            if (!isCursorExpired(err)) throw err;
            deps.log.info({ ...ids }, 'calendar sync cursor expired; starting a new round');
            plan = await fresh();
          }
        } else plan = await fresh();
      } else {
        const events = await provider.listEvents({
          accessToken,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          maxResults: cfg.maxEvents,
        });
        // Windowed providers never keep a cursor (clears one left from a delta-enabled run).
        plan = {
          from,
          to,
          events,
          complete: events.length < cfg.maxEvents,
          ...(s.syncCursor ? { cursor: null } : {}),
        };
      }
      const r = await deps.repo.applySync(d.organizationId, {
        connectionId: d.id,
        ...plan,
        now,
        nextSyncInMs: calendarSyncNextMs(cfg, deps.random),
        lease,
        ...(cfg.autoLinkEnabled ? { autoLink: autoLinkCandidates(plan.events) } : {}),
      });
      if (!r.applied) {
        result.skipped++;
        continue;
      }
      result.synced++;
      result.upserted += r.upserted;
      result.cancelled += r.cancelled;
      result.autoLinked += r.autoLinked ?? 0;
    } catch (err) {
      result.failed++;
      const permanent = isPermanentCalendarError(err);
      const next = failures + 1;
      deps.log.warn({ ...ids, ...errInfo(err), permanent, failures: next }, 'calendar sync failed');
      try {
        // Lease-guarded like recordFailure: a lost claim never marks a connection another sweep just synced.
        if (permanent && lease) await deps.repo.markError(d.organizationId, d.id, { lease });
        else if (lease)
          await deps.repo.recordFailure(d.organizationId, d.id, {
            syncFailures: next,
            retryInMs: calendarSyncBackoffMs(next, cfg, deps.random),
            lease,
          });
      } catch {
        // the next sweep retries
      }
    }
  }
  if (due.length) deps.log.info({ ...result }, 'calendar sync sweep');
  return result;
}

/** Interval scheduler (no overlap within a process). Run it on a single worker replica. */
export function startCalendarSyncScheduler(
  deps: CalendarSyncDeps,
  opts: { tickMs?: number } = {},
): { close: () => Promise<void>; tick: () => Promise<void> } {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (!running)
      running = runCalendarSyncSweep(deps)
        .then(() => undefined)
        .catch((err: unknown) => {
          deps.log.warn(errInfo(err), 'calendar sync sweep failed');
        })
        .finally(() => {
          running = null;
        });
    return running;
  };
  const timer = setInterval(() => void tick(), opts.tickMs ?? 60_000);
  timer.unref();
  return {
    tick,
    close: async () => {
      clearInterval(timer);
      await running;
    },
  };
}

export class CalendarSyncEnvError extends Error {}

const TICK_MIN = 5_000;
const TICK_MAX = 3_600_000;
/** CALENDAR_SYNC_TICK_MS: unset = 60 s; anything else must be an integer in range or startup fails (names key only). */
function tickEnv(v: string | undefined): number {
  if (v === undefined || v.trim() === '') return 60_000;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < TICK_MIN || n > TICK_MAX)
    throw new CalendarSyncEnvError(
      `CALENDAR_SYNC_TICK_MS must be an integer in ${TICK_MIN}..${TICK_MAX}`,
    );
  return n;
}

export interface CalendarSyncWorkerEnv {
  enabled: boolean;
  tickMs: number;
  config: CalendarSyncConfig;
}

const intEnv = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

/** Off unless CALENDAR_SYNC_ENABLED=true. A bad tick throws; other bad numbers fall back to defaults; the window is capped at 62 days. */
export function loadCalendarSyncEnv(env: NodeJS.ProcessEnv = process.env): CalendarSyncWorkerEnv {
  return {
    enabled: env.CALENDAR_SYNC_ENABLED?.trim().toLowerCase() === 'true',
    tickMs: tickEnv(env.CALENDAR_SYNC_TICK_MS),
    config: {
      intervalMs: intEnv(
        env.CALENDAR_SYNC_INTERVAL_MS,
        CALENDAR_SYNC_DEFAULTS.intervalMs,
        60_000,
        DAY,
      ),
      pastMs: intEnv(env.CALENDAR_SYNC_PAST_DAYS, 1, 0, 31) * DAY,
      futureMs: intEnv(env.CALENDAR_SYNC_FUTURE_DAYS, 30, 1, 61) * DAY,
      maxBackoffMs: CALENDAR_SYNC_DEFAULTS.maxBackoffMs,
      limit: intEnv(env.CALENDAR_SYNC_BATCH, CALENDAR_SYNC_DEFAULTS.limit, 1, 500),
      maxEvents: CALENDAR_SYNC_DEFAULTS.maxEvents,
      perOrgLimit: intEnv(
        env.CALENDAR_SYNC_PER_ORG_LIMIT,
        CALENDAR_SYNC_DEFAULTS.perOrgLimit,
        1,
        500,
      ),
      deltaEnabled: env.CALENDAR_SYNC_DELTA_ENABLED?.trim().toLowerCase() === 'true',
      cursorMaxLagMs: CALENDAR_SYNC_DEFAULTS.cursorMaxLagMs,
      autoLinkEnabled: env.CALENDAR_AUTO_LINK_ENABLED?.trim().toLowerCase() === 'true',
    },
  };
}
