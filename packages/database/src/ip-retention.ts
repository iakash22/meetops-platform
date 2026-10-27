import type { PrismaClient } from '@prisma/client';

/** ADR-014: raw IPs on sessions and audit events are nulled after this many days; coarse geo is kept. */
export const IP_RETENTION_DAYS = 30;

export interface IpRetentionResult {
  sessionsRedacted: number;
  auditEventsRedacted: number;
}

/**
 * Null `ip_address` older than `days` (>= 30, enforced in SQL too) on sessions and audit_events via the SECURITY DEFINER
 * `redact_expired_ip_addresses` (append-only audit trigger allows only this exact change). Idempotent.
 */
export async function redactExpiredIpAddresses(
  client: Pick<PrismaClient, '$queryRaw'>,
  days: number = IP_RETENTION_DAYS,
): Promise<IpRetentionResult> {
  if (!Number.isInteger(days) || days < IP_RETENTION_DAYS) {
    throw new RangeError(`days must be an integer >= ${IP_RETENTION_DAYS}`);
  }
  const rows = await client.$queryRaw<
    { sessions_redacted: bigint; audit_events_redacted: bigint }[]
  >`
    SELECT * FROM public.redact_expired_ip_addresses(${days}::integer)`;
  const r = rows[0];
  return {
    sessionsRedacted: Number(r?.sessions_redacted ?? 0),
    auditEventsRedacted: Number(r?.audit_events_redacted ?? 0),
  };
}
