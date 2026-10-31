import type { CalendarSyncEventInput, CalendarSyncSecrets } from '@meetops/database';

/**
 * Phase 7 calendar background sync (modelled on integrations/token-refresh.ts). Off by default
 * (CALENDAR_SYNC_ENABLED=true opts in). Each sweep pulls a rolling window of events for every due, active calendar
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
  readSecrets(organizationId: string, id: string): Promise<CalendarSyncSecrets | null>;
  updateTokens(
    organizationId: string,
    id: string,
    t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
  ): Promise<void>;
  markError(organizationId: string, id: string): Promise<void>;
  recordFailure(
    organizationId: string,
    id: string,
    s: { syncFailures: number; nextSyncAt: Date },
  ): Promise<void>;
  applySync(
    organizationId: string,
    input: {
      connectionId: string;
      from: Date;
      to: Date;
      events: CalendarSyncEventInput[];
      complete: boolean;
      now: Date;
      nextSyncAt: Date;
    },
  ): Promise<{ upserted: number; cancelled: number; applied: boolean }>;
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
};
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
  const nowMs = (deps.now ?? Date.now)();
  const now = new Date(nowMs);
  const span = Math.min(cfg.pastMs + cfg.futureMs, CALENDAR_SYNC_MAX_WINDOW_MS);
  const from = new Date(nowMs - Math.min(cfg.pastMs, span));
  const to = new Date(from.getTime() + span);
  const due = await deps.repo.listDueForSync(now, cfg.limit);
  const result: CalendarSyncResult = {
    synced: 0,
    failed: 0,
    skipped: 0,
    upserted: 0,
    cancelled: 0,
  };

  for (const d of due) {
    const ids = { organizationId: d.organizationId, connectionId: d.id, provider: d.provider };
    const provider = deps.providers[d.provider];
    if (!provider) {
      result.skipped++;
      continue;
    }
    let failures = 0;
    try {
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
      const events = await provider.listEvents({
        accessToken,
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        maxResults: cfg.maxEvents,
      });
      const r = await deps.repo.applySync(d.organizationId, {
        connectionId: d.id,
        from,
        to,
        events,
        complete: events.length < cfg.maxEvents,
        now,
        nextSyncAt: new Date(nowMs + calendarSyncNextMs(cfg, deps.random)),
      });
      if (!r.applied) {
        result.skipped++;
        continue;
      }
      result.synced++;
      result.upserted += r.upserted;
      result.cancelled += r.cancelled;
    } catch (err) {
      result.failed++;
      const permanent = isPermanentCalendarError(err);
      const next = failures + 1;
      deps.log.warn({ ...ids, ...errInfo(err), permanent, failures: next }, 'calendar sync failed');
      try {
        if (permanent) await deps.repo.markError(d.organizationId, d.id);
        else
          await deps.repo.recordFailure(d.organizationId, d.id, {
            syncFailures: next,
            nextSyncAt: new Date(nowMs + calendarSyncBackoffMs(next, cfg, deps.random)),
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

export interface CalendarSyncWorkerEnv {
  enabled: boolean;
  tickMs: number;
  config: CalendarSyncConfig;
}

const intEnv = (v: string | undefined, def: number, min: number, max: number) => {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
};

/** Off unless CALENDAR_SYNC_ENABLED=true. Bad numbers fall back to defaults; the window is capped at 62 days. */
export function loadCalendarSyncEnv(env: NodeJS.ProcessEnv = process.env): CalendarSyncWorkerEnv {
  return {
    enabled: env.CALENDAR_SYNC_ENABLED?.trim().toLowerCase() === 'true',
    tickMs: intEnv(env.CALENDAR_SYNC_TICK_MS, 60_000, 5_000, 3_600_000),
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
    },
  };
}
