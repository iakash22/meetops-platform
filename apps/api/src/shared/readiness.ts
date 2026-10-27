/**
 * Readiness probes for GET /ready (Phase 9 monitoring).
 *
 * - Each dependency the process actually uses (Postgres via Prisma, Redis) gets one cheap probe.
 * - Probes run in parallel with a per-probe timeout; concurrent /ready calls share one in-flight run.
 * - The response and logs carry check names and outcomes only (`ok` | `fail` | `timeout`), never
 *   error messages, connection strings or hosts.
 */
export type ReadinessOutcome = 'ok' | 'fail' | 'timeout';

export interface ReadinessCheck {
  name: string;
  probe: () => Promise<unknown>;
}

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, ReadinessOutcome>;
}

export const DEFAULT_READINESS_TIMEOUT_MS = 2000;

/** READINESS_TIMEOUT_MS: 100..30000 ms, otherwise the default. */
export function readinessTimeoutFromEnv(v: string | undefined): number {
  if (!v || !/^[0-9]{1,5}$/.test(v)) return DEFAULT_READINESS_TIMEOUT_MS;
  const n = Number(v);
  return n >= 100 && n <= 30_000 ? n : DEFAULT_READINESS_TIMEOUT_MS;
}

async function runOne(check: ReadinessCheck, timeoutMs: number): Promise<ReadinessOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReadinessOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(check.probe)
        .then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createReadiness(
  checks: ReadinessCheck[],
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
) {
  let inFlight: Promise<ReadinessReport> | undefined;
  const run = async (): Promise<ReadinessReport> => {
    const outcomes = await Promise.all(checks.map((c) => runOne(c, timeoutMs)));
    const report: ReadinessReport = { ready: true, checks: {} };
    checks.forEach((c, i) => {
      report.checks[c.name] = outcomes[i]!;
      if (outcomes[i] !== 'ok') report.ready = false;
    });
    return report;
  };
  return {
    names: checks.map((c) => c.name),
    check(): Promise<ReadinessReport> {
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}

type PingableRedis = { ping?: () => Promise<unknown> };
type QueryableDb = { $queryRaw?: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> };

/** Probes for the clients the server holds: `SELECT 1` on Prisma, `PING` on Redis. Absent clients are skipped. */
export function defaultReadinessChecks(deps: { db?: unknown; redis?: unknown }): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  const db = deps.db as QueryableDb | undefined;
  if (db?.$queryRaw) checks.push({ name: 'database', probe: () => db.$queryRaw!`SELECT 1` });
  const redis = deps.redis as PingableRedis | undefined;
  if (redis?.ping) checks.push({ name: 'redis', probe: () => redis.ping!() });
  return checks;
}
