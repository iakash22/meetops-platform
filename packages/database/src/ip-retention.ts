import type { PrismaClient } from '@prisma/client';

/** ADR-014: raw IPs on sessions, audit events and password resets are nulled after this many days; geo is kept. */
export const IP_RETENTION_DAYS = 30;
export const IP_RETENTION_BATCH = 1000;
/** Safety cap on batches per run; the next daily run continues. */
export const IP_RETENTION_MAX_BATCHES = 1000;

export interface IpRetentionResult {
  sessionsRedacted: number;
  auditEventsRedacted: number;
  passwordResetsRedacted: number;
}

type Row = {
  sessions_redacted: bigint;
  audit_events_redacted: bigint;
  password_resets_redacted: bigint;
};

/**
 * Null `ip_address` older than `days` (>= 30, enforced in SQL too) on sessions, audit_events and password_resets via
 * the SECURITY DEFINER `redact_expired_ip_addresses`, in batches until nothing is left (or the batch cap). The
 * append-only audit trigger allows only this exact change. Idempotent; uses server time.
 */
export async function redactExpiredIpAddresses(
  client: Pick<PrismaClient, '$queryRaw'>,
  days: number = IP_RETENTION_DAYS,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<IpRetentionResult> {
  if (!Number.isInteger(days) || days < IP_RETENTION_DAYS) {
    throw new RangeError(`days must be an integer >= ${IP_RETENTION_DAYS}`);
  }
  const batch = opts.batchSize ?? IP_RETENTION_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > 10_000) {
    throw new RangeError('batchSize must be an integer in 1..10000');
  }
  const total: IpRetentionResult = {
    sessionsRedacted: 0,
    auditEventsRedacted: 0,
    passwordResetsRedacted: 0,
  };
  for (let i = 0; i < (opts.maxBatches ?? IP_RETENTION_MAX_BATCHES); i++) {
    const rows = await client.$queryRaw<Row[]>`
      SELECT * FROM public.redact_expired_ip_addresses(${days}::integer, ${batch}::integer)`;
    const s = Number(rows[0]?.sessions_redacted ?? 0);
    const a = Number(rows[0]?.audit_events_redacted ?? 0);
    const p = Number(rows[0]?.password_resets_redacted ?? 0);
    total.sessionsRedacted += s;
    total.auditEventsRedacted += a;
    total.passwordResetsRedacted += p;
    if (s < batch && a < batch && p < batch) break;
  }
  return total;
}
