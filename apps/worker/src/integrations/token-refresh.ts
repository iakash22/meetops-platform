import type {
  IntegrationConnectionRecord,
  IntegrationSecrets,
  UpsertIntegrationConnectionInput,
} from '@meetops/database';

/** Repository surface the sweep needs (createIntegrationConnectionRepository with the encrypting cipher). */
export interface TokenRefreshRepository {
  listDueForRefresh(
    before: Date,
    limit?: number,
  ): Promise<{ organizationId: string; id: string; provider: string }[]>;
  get(organizationId: string, id: string): Promise<IntegrationConnectionRecord | null>;
  readSecrets(organizationId: string, id: string): Promise<IntegrationSecrets | null>;
  upsert(
    organizationId: string,
    input: UpsertIntegrationConnectionInput,
  ): Promise<IntegrationConnectionRecord>;
  setStatus(
    organizationId: string,
    id: string,
    status: 'active' | 'error',
  ): Promise<IntegrationConnectionRecord | null>;
}

/** Provider calls, injected so the sweep stays fetch/SDK agnostic (JiraOAuthClient / GitHubAppClient in prod). */
export interface TokenRefreshProviders {
  jira?: {
    refresh(
      refreshToken: string,
    ): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>;
  };
  github?: {
    createInstallationToken(installationId: string): Promise<{ token: string; expiresAt: Date }>;
  };
}

export interface TokenRefreshLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface TokenRefreshDeps {
  repo: TokenRefreshRepository;
  providers: TokenRefreshProviders;
  log: TokenRefreshLog;
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

/**
 * One sweep: refresh every active connection whose access token expires within the window. Jira rotates the
 * refresh token (both are re-encrypted via upsert); GitHub mints a new installation token. A permanent failure
 * marks the connection `error` (the UI asks for a reconnect); transient failures are retried on the next sweep.
 * Only identifiers and error names are logged, never token material.
 */
export async function runTokenRefreshSweep(deps: TokenRefreshDeps): Promise<TokenRefreshResult> {
  const now = (deps.now ?? Date.now)();
  const due = await deps.repo.listDueForRefresh(
    new Date(now + (deps.windowMs ?? 600_000)),
    deps.limit ?? 100,
  );
  const result: TokenRefreshResult = { refreshed: 0, failed: 0, skipped: 0 };
  for (const d of due) {
    const ids = { organizationId: d.organizationId, integrationId: d.id, provider: d.provider };
    try {
      const conn = await deps.repo.get(d.organizationId, d.id);
      const secrets = conn && (await deps.repo.readSecrets(d.organizationId, d.id));
      if (!conn || conn.status !== 'active' || !secrets) {
        result.skipped++;
        continue;
      }
      const base = {
        provider: conn.provider,
        displayName: conn.displayName,
        externalAccountId: conn.externalAccountId,
        connectedById: conn.connectedById,
        webhookSecret: secrets.webhookSecret,
      };
      if (conn.provider === 'jira') {
        if (!deps.providers.jira || !secrets.refreshToken) {
          result.skipped++;
          continue;
        }
        const t = await deps.providers.jira.refresh(secrets.refreshToken);
        await deps.repo.upsert(d.organizationId, {
          ...base,
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          accessTokenExpiresAt: new Date(t.expiresAt),
        });
      } else if (conn.provider === 'github') {
        if (!deps.providers.github) {
          result.skipped++;
          continue;
        }
        const t = await deps.providers.github.createInstallationToken(conn.externalAccountId);
        await deps.repo.upsert(d.organizationId, {
          ...base,
          accessToken: t.token,
          refreshToken: null,
          accessTokenExpiresAt: t.expiresAt,
        });
      } else {
        result.skipped++;
        continue;
      }
      result.refreshed++;
    } catch (err) {
      result.failed++;
      const permanent = isPermanent(err);
      deps.log.warn(
        { ...ids, errName: err instanceof Error ? err.name : 'unknown', permanent },
        'integration token refresh failed',
      );
      if (permanent) {
        try {
          await deps.repo.setStatus(d.organizationId, d.id, 'error');
        } catch {
          // next sweep retries
        }
      }
    }
  }
  if (due.length) deps.log.info({ ...result }, 'integration token refresh sweep');
  return result;
}

/**
 * Interval scheduler (no overlap within a process). Run it on a single worker replica: Jira rotates refresh
 * tokens, so two concurrent sweeps could invalidate each other's grant.
 */
export function startTokenRefreshScheduler(
  deps: TokenRefreshDeps,
  opts: { intervalMs?: number } = {},
): { close: () => Promise<void>; tick: () => Promise<void> } {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (!running)
      running = runTokenRefreshSweep(deps)
        .then(() => undefined)
        .catch((err: unknown) => {
          deps.log.warn(
            { errName: err instanceof Error ? err.name : 'unknown' },
            'integration token refresh sweep failed',
          );
        })
        .finally(() => {
          running = null;
        });
    return running;
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 300_000);
  timer.unref();
  return {
    tick,
    close: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
