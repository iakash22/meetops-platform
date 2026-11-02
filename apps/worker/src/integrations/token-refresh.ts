import {
  boundedLeaseOp,
  LeaseTimeoutError,
  TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
  TOKEN_REFRESH_LEASE_TTL_MS,
  tokenRefreshLeaseKey,
  type ConnectionLease,
} from '@meetops/integrations';
import type {
  IntegrationRefreshSnapshot,
  RefreshedIntegrationTokens,
  SaveRefreshedTokensResult,
} from '@meetops/database';

// The lease primitives moved to @meetops/integrations (shared with the API's on-demand refresh); re-exported so
// existing worker imports keep working.
export {
  LeaseTimeoutError,
  TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
  TOKEN_REFRESH_LEASE_TTL_MS,
  tokenRefreshLeaseKey,
  type ConnectionLease,
};

/** Repository surface the sweep needs (createIntegrationConnectionRepository with the encrypting cipher). */
export interface TokenRefreshRepository {
  listDueForRefresh(
    before: Date,
    limit?: number,
  ): Promise<{ organizationId: string; id: string; provider: string }[]>;
  /** Record + secrets + fence from one row read (the fence guards every write below). */
  readForRefresh(organizationId: string, id: string): Promise<IntegrationRefreshSnapshot | null>;
  /** Compare-and-swap on the fence: 'superseded' when a newer write landed first (nothing written). */
  saveRefreshedTokens(
    organizationId: string,
    id: string,
    tokens: RefreshedIntegrationTokens,
    fence: string,
  ): Promise<SaveRefreshedTokensResult>;
  /** With `fence`, writes only if the tokens are unchanged since readForRefresh (null otherwise). */
  setStatus(
    organizationId: string,
    id: string,
    status: 'active' | 'error',
    opts?: { fence?: string },
  ): Promise<unknown>;
}

/**
 * Provider calls, injected so the sweep stays fetch/SDK agnostic (JiraOAuthClient / GitHubAppClient in prod). The
 * sweep passes an AbortSignal that fires at its refresh deadline; it also stops waiting at that deadline itself, so
 * a provider that ignores the signal still cannot hold the lease past it.
 */
export interface TokenRefreshProviders {
  jira?: {
    refresh(
      refreshToken: string,
      opts?: { signal?: AbortSignal },
    ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>;
  };
  github?: {
    createInstallationToken(
      installationId: string,
      opts?: { signal?: AbortSignal },
    ): Promise<{ token: string; expiresAt: Date }>;
  };
}

export interface TokenRefreshLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/** Deadline over the whole provider refresh call (request + body). Capped at half the lease TTL. */
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
/** Attempts to persist tokens the provider already rotated, before the connection is marked needs-reauth. */
export const TOKEN_REFRESH_SAVE_ATTEMPTS = 3;

/** The provider refresh passed its deadline (transient: the next sweep retries). */
export class TokenRefreshTimeoutError extends Error {
  constructor() {
    super('integration token refresh timed out');
    this.name = 'TokenRefreshTimeoutError';
  }
}

export interface TokenRefreshDeps {
  repo: TokenRefreshRepository;
  providers: TokenRefreshProviders;
  log: TokenRefreshLog;
  /** Per-connection exclusivity; production always sets it (registerTokenRefreshJob). */
  lease?: ConnectionLease;
  leaseTtlMs?: number;
  /** Deadline over the provider refresh call (default TOKEN_REFRESH_TIMEOUT_MS, capped at half the lease TTL). */
  refreshTimeoutMs?: number;
  /** Timeout for each lease Redis call (default TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS). */
  leaseOpTimeoutMs?: number;
  /** Persist attempts for rotated tokens (default TOKEN_REFRESH_SAVE_ATTEMPTS) and the base backoff between them. */
  saveAttempts?: number;
  saveRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Refresh connections expiring within this window (default 10 min). */
  windowMs?: number;
  limit?: number;
}

export interface TokenRefreshResult {
  refreshed: number;
  failed: number;
  skipped: number;
}

/** Errors that mean the grant is gone (re-consent needed), as opposed to a transient upstream failure. */
function isPermanent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;
  return (
    code === 'invalid_grant' ||
    code === 'missing_refresh_token' ||
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404
  );
}

const errName = (err: unknown) => (err instanceof Error ? err.name : 'unknown');

/** Runs `call` with an AbortSignal that fires after `ms`, and stops waiting then even if `call` ignores it. */
async function withDeadline<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TokenRefreshTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One sweep: refresh every active connection whose access token expires within the window. Jira rotates the
 * refresh token; GitHub mints a new installation token. Per connection, under the lease:
 *  - read record + secrets + fence in one query; the provider call runs under one deadline (refreshTimeoutMs);
 *  - before writing, re-confirm the lease (renewing it); the write is fenced in the database either way, so a slow
 *    refresh that outlived its lease cannot overwrite a newer success (it is reported as superseded);
 *  - a failed save is retried (saveAttempts) whether or not the lease is still held (Redis down never drops the
 *    tokens); if a rotated Jira token still cannot be stored, the connection is marked `error` under the fence
 *    alone (needs reauth: the UI asks for a reconnect) and that is logged, never dropped silently;
 *  - a 'superseded' after a save that errored is re-checked: if our tokens are what is stored, it counts as saved;
 *  - a permanent provider failure marks the connection `error`, but only while the lease is held and the fence
 *    still matches; transient failures are retried on the next sweep.
 * Only identifiers and error names are logged, never token material.
 */
export async function runTokenRefreshSweep(deps: TokenRefreshDeps): Promise<TokenRefreshResult> {
  const clock = deps.now ?? Date.now;
  const now = clock();
  const ttlMs = deps.leaseTtlMs ?? TOKEN_REFRESH_LEASE_TTL_MS;
  const refreshTimeoutMs = Math.max(
    1,
    Math.min(deps.refreshTimeoutMs ?? TOKEN_REFRESH_TIMEOUT_MS, Math.floor(ttlMs / 2)),
  );
  const leaseOpMs = deps.leaseOpTimeoutMs ?? TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS;
  const saveAttempts = Math.max(1, Math.trunc(deps.saveAttempts ?? TOKEN_REFRESH_SAVE_ATTEMPTS));
  const saveRetryDelayMs = deps.saveRetryDelayMs ?? 250;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const due = await deps.repo.listDueForRefresh(
    new Date(now + (deps.windowMs ?? 600_000)),
    deps.limit ?? 100,
  );
  const result: TokenRefreshResult = { refreshed: 0, failed: 0, skipped: 0 };
  const cutoff = now + (deps.windowMs ?? 600_000);
  for (const d of due) {
    const ids = { organizationId: d.organizationId, integrationId: d.id, provider: d.provider };
    const leaseKey = tokenRefreshLeaseKey(d.organizationId, d.id);
    let leaseToken: string | null = null;
    // Local view of when our lease runs out (taken before acquire, so it never overestimates).
    let leaseDeadline = clock() + ttlMs;
    if (deps.lease) {
      try {
        leaseToken = await boundedLeaseOp(deps.lease.acquire(leaseKey, ttlMs), leaseOpMs);
      } catch (err) {
        // Fail closed: never refresh without the lease. Transient, so the next sweep retries.
        result.failed++;
        deps.log.warn(
          { ...ids, errName: errName(err) },
          'integration token refresh lease unavailable',
        );
        continue;
      }
      if (!leaseToken) {
        // Another sweep is refreshing this connection right now: skip, not an error.
        result.skipped++;
        continue;
      }
    }

    /** Still ours? Checked (and renewed) right before every write; false on expiry, loss or a Redis failure. */
    const leaseHeld = async (): Promise<boolean> => {
      if (!deps.lease || !leaseToken) return true;
      if (clock() >= leaseDeadline) return false;
      const startedAt = clock();
      try {
        const ok = await boundedLeaseOp(deps.lease.confirm(leaseKey, leaseToken, ttlMs), leaseOpMs);
        if (ok) leaseDeadline = startedAt + ttlMs;
        return ok;
      } catch (err) {
        deps.log.warn(
          { ...ids, errName: errName(err) },
          'integration token refresh lease check failed',
        );
        return false;
      }
    };

    /**
     * Marks needs-reauth (status error) under the fence. A permanent provider error is marked only while the lease
     * is also held (a holder that outlived its lease must not mark over a newer holder). After a failed persist of
     * rotated tokens the fence alone is enough (#375 Arch L2): the grant we spent is ours, any newer write moves the
     * fence, and requiring the lease would leave the connection `active` with a dead grant whenever Redis is down.
     */
    const markError = async (
      fence: string,
      reason: 'permanent' | 'persist_failed',
    ): Promise<boolean> => {
      if (reason === 'permanent' && !(await leaseHeld())) {
        deps.log.warn(
          { ...ids, reason },
          'integration token refresh lease lost; not marking error',
        );
        return false;
      }
      try {
        const marked = await deps.repo.setStatus(d.organizationId, d.id, 'error', { fence });
        if (!marked)
          deps.log.info({ ...ids, reason }, 'integration token refresh error mark superseded');
        return Boolean(marked);
      } catch (err) {
        deps.log.warn(
          { ...ids, reason, errName: errName(err) },
          'integration token refresh error mark failed',
        );
        return false; // the next sweep retries
      }
    };

    let fence: string | undefined;
    try {
      // Read under the lease, so a refresh that just finished elsewhere is seen (rotated token, new expiry).
      const snap = await deps.repo.readForRefresh(d.organizationId, d.id);
      if (!snap || snap.connection.status !== 'active') {
        result.skipped++;
        continue;
      }
      const { connection: conn, secrets } = snap;
      fence = snap.fence;
      if (conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() > cutoff) {
        result.skipped++; // refreshed by another sweep since listDueForRefresh
        continue;
      }
      let tokens: RefreshedIntegrationTokens;
      let rotates: boolean;
      if (conn.provider === 'jira') {
        const jira = deps.providers.jira;
        const refreshToken = secrets.refreshToken;
        if (!jira || !refreshToken) {
          result.skipped++;
          continue;
        }
        const t = await withDeadline(refreshTimeoutMs, (signal) =>
          jira.refresh(refreshToken, { signal }),
        );
        tokens = {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          webhookSecret: secrets.webhookSecret,
          accessTokenExpiresAt: new Date(t.expiresAt),
        };
        rotates = true; // the old refresh token is now spent: losing the new one breaks the grant
      } else if (conn.provider === 'github') {
        const github = deps.providers.github;
        if (!github) {
          result.skipped++;
          continue;
        }
        const t = await withDeadline(refreshTimeoutMs, (signal) =>
          github.createInstallationToken(conn.externalAccountId, { signal }),
        );
        tokens = {
          accessToken: t.token,
          refreshToken: null,
          webhookSecret: secrets.webhookSecret,
          accessTokenExpiresAt: t.expiresAt,
        };
        rotates = false; // a new installation token can be minted again on the next sweep
      } else {
        result.skipped++;
        continue;
      }

      if (!(await leaseHeld())) {
        // The provider already issued these tokens, so do not drop them: the database fence below still stops
        // this write if a newer refresh landed while we were slow.
        deps.log.warn(ids, 'integration token refresh outlived its lease; saving under the fence');
      }
      let saved: SaveRefreshedTokensResult | undefined;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= saveAttempts && saved === undefined; attempt++) {
        try {
          saved = await deps.repo.saveRefreshedTokens(d.organizationId, d.id, tokens, fence);
        } catch (err) {
          lastErr = err;
          deps.log.warn(
            { ...ids, attempt, of: saveAttempts, errName: errName(err) },
            'integration token refresh save failed',
          );
          if (attempt < saveAttempts) await sleep(saveRetryDelayMs * attempt);
        }
      }
      let outcome: SaveRefreshedTokensResult | 'other_write' | undefined = saved;
      if (saved === 'superseded' && lastErr !== undefined) {
        // #375 Arch L1: an earlier attempt failed with an unclear outcome, so 'superseded' may just be our own
        // commit having moved the fence. Re-read and compare instead of reporting a newer write that never was.
        const after = await deps.repo.readForRefresh(d.organizationId, d.id).catch(() => null);
        const ours =
          after?.connection.status === 'active' &&
          after.secrets.accessToken === tokens.accessToken &&
          after.secrets.refreshToken === tokens.refreshToken;
        outcome = ours ? 'saved' : 'other_write';
        deps.log.info(
          { ...ids, errName: errName(lastErr), committed: ours },
          ours
            ? 'integration token refresh save committed despite an error reply; tokens are stored'
            : 'integration token refresh save outcome was unclear; a different write is stored, ours is not',
        );
      }
      if (outcome === 'saved') {
        result.refreshed++;
      } else if (outcome === 'superseded') {
        // A newer refresh, reconnect or revoke landed first; its state wins and ours is discarded on purpose.
        result.skipped++;
        deps.log.info(ids, 'integration token refresh superseded by a newer write; not saved');
      } else if (outcome === 'other_write') {
        result.skipped++; // logged above
      } else {
        result.failed++;
        const markedNeedsReauth = rotates ? await markError(fence, 'persist_failed') : false;
        deps.log.warn(
          {
            ...ids,
            errName: errName(lastErr),
            attempts: saveAttempts,
            rotated: rotates,
            markedNeedsReauth,
          },
          rotates
            ? 'integration token refresh could not store the rotated tokens; connection needs reauth'
            : 'integration token refresh could not store the new token; retrying next sweep',
        );
      }
    } catch (err) {
      result.failed++;
      const permanent = isPermanent(err);
      deps.log.warn(
        { ...ids, errName: errName(err), permanent },
        'integration token refresh failed',
      );
      if (permanent && fence !== undefined) await markError(fence, 'permanent');
    } finally {
      if (deps.lease && leaseToken) {
        try {
          await boundedLeaseOp(deps.lease.release(leaseKey, leaseToken), leaseOpMs);
        } catch (err) {
          // The lease expires after its TTL.
          deps.log.warn(
            { ...ids, errName: errName(err) },
            'integration token refresh lease release failed',
          );
        }
      }
    }
  }
  if (due.length) deps.log.info({ ...result }, 'integration token refresh sweep');
  return result;
}
