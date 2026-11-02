import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getPrismaClient } from './client.js';
import type { IntegrationSecretCipher } from './integration-connections.js';
import { runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * Phase 7 calendar background sync. The cross-tenant sweep finds due connections through the SECURITY DEFINER
 * calendar_connections_due_for_sync() (ids only), then re-enters forced RLS per organization for every read/write.
 *
 * Token envelopes use the same AAD scheme as the API's PrismaCalendarConnections: per field
 * (`calendar:<id>:access|refresh`), falling back to the pre-v2 (org + id) context on read. Plaintext tokens are only
 * returned by readSecrets and never appear in records, errors or logs.
 */
export interface CalendarSyncEventInput {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  conferenceUrl?: string;
  htmlLink?: string;
  organizerEmail?: string;
  attendeeCount: number;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface CalendarSyncedEvent extends CalendarSyncEventInput {
  connectionId: string;
  provider: string;
}

export interface CalendarSyncSecrets {
  userId: string;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  syncFailures: number;
}

export interface CalendarSyncCoverage {
  from: Date;
  to: Date;
  lastSyncedAt: Date;
}

export interface CalendarSyncRepositoryOptions extends RepositoryOptions {
  /** Only needed for readSecrets/updateTokens (the API read-through needs none). */
  cipher?: IntegrationSecretCipher;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVELOPE_RE = /^v1\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HTTPS = (v: string | undefined) => (v && /^https:\/\//.test(v) ? v.slice(0, 2048) : null);
const STATUSES = new Set(['confirmed', 'tentative', 'cancelled']);

export function createCalendarSyncRepository(options: CalendarSyncRepositoryOptions = {}) {
  const client = () => options.client ?? getPrismaClient();
  const run = <T>(organizationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runWithOrganizationContext(client(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  const cipher = (): IntegrationSecretCipher => {
    if (!options.cipher) throw new Error('calendar sync repository has no cipher');
    return options.cipher;
  };
  const ctx = (organizationId: string, id: string, field: 'access' | 'refresh') => ({
    organizationId,
    integrationId: `calendar:${id}:${field}`,
  });
  const open = async (
    organizationId: string,
    id: string,
    enc: string,
    field: 'access' | 'refresh',
  ) => {
    try {
      return await cipher().decrypt(enc, ctx(organizationId, id, field));
    } catch {
      try {
        return await cipher().decrypt(enc, { organizationId, integrationId: id });
      } catch {
        return null;
      }
    }
  };

  return {
    /** Active connections due for a sync (never-synced first), ids only. */
    async listDueForSync(
      now: Date,
      limit = 50,
    ): Promise<{ organizationId: string; id: string; userId: string; provider: string }[]> {
      const rows = await client().$transaction(
        (tx) => tx.$queryRaw<{ org_id: string; id: string; user_id: string; provider: string }[]>`
          SELECT org_id, id, user_id, provider FROM calendar_connections_due_for_sync(${now}, ${limit}::int)`,
      );
      return rows.map((r) => ({
        organizationId: r.org_id,
        id: r.id,
        userId: r.user_id,
        provider: r.provider,
      }));
    },

    /** Decrypted tokens of an ACTIVE connection, or null (unknown / other org / error / revoked / undecryptable). */
    async readSecrets(organizationId: string, id: string): Promise<CalendarSyncSecrets | null> {
      if (!UUID_RE.test(id)) return null;
      const row = await run(organizationId, (tx) =>
        tx.calendarConnection.findFirst({
          where: { id, organizationId, status: 'active' },
          select: {
            userId: true,
            provider: true,
            accessTokenEnc: true,
            refreshTokenEnc: true,
            accessTokenExpiresAt: true,
            syncFailures: true,
          },
        }),
      );
      if (!row?.accessTokenEnc) return null;
      const accessToken = await open(organizationId, id, row.accessTokenEnc, 'access');
      if (accessToken === null) return null;
      const refreshToken = row.refreshTokenEnc
        ? await open(organizationId, id, row.refreshTokenEnc, 'refresh')
        : null;
      return {
        userId: row.userId,
        provider: row.provider,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: row.accessTokenExpiresAt,
        syncFailures: row.syncFailures,
      };
    },

    /** Stores refreshed tokens (per-field AAD). An empty refresh token keeps the stored one (Google omits it). */
    async updateTokens(
      organizationId: string,
      id: string,
      t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
    ): Promise<void> {
      if (!UUID_RE.test(id)) return;
      const accessTokenEnc = await cipher().encrypt(
        t.accessToken,
        ctx(organizationId, id, 'access'),
      );
      const keyId = ENVELOPE_RE.exec(accessTokenEnc)?.[1];
      if (!keyId) throw new Error('cipher returned a value that is not a v1 envelope');
      const refreshTokenEnc = t.refreshToken
        ? await cipher().encrypt(t.refreshToken, ctx(organizationId, id, 'refresh'))
        : undefined;
      await run(organizationId, (tx) =>
        tx.calendarConnection.updateMany({
          where: { id, organizationId, status: 'active' },
          data: {
            accessTokenEnc,
            ...(refreshTokenEnc ? { refreshTokenEnc } : {}),
            tokenKeyId: keyId,
            accessTokenExpiresAt: t.accessTokenExpiresAt,
          },
        }),
      );
    },

    /**
     * Atomic per-connection claim for a sweep. One conditional UPDATE, timed by the database clock at the moment of
     * the claim (clock_timestamp(), not the sweep's start): it only matches an active connection that is due *now*,
     * and moves next_sync_at to now + leaseMs. Under READ COMMITTED a concurrent UPDATE waits for the row lock,
     * re-checks the predicate and matches nothing, so exactly one replica wins (same effect as FOR UPDATE SKIP
     * LOCKED; no migration). The returned `lease` (the stored next_sync_at) is the claim token: applySync and
     * recordFailure only write while next_sync_at still equals it. If the holder dies or overruns, the lease
     * expires, another sweep may claim it, and the old holder's writes are then refused.
     */
    async claimForSync(
      organizationId: string,
      id: string,
      leaseMs: number,
    ): Promise<{ lease: Date } | null> {
      if (!UUID_RE.test(id) || !Number.isInteger(leaseMs) || leaseMs <= 0) return null;
      const rows = await run(
        organizationId,
        (tx) =>
          tx.$queryRaw<{ next_sync_at: Date }[]>`
          UPDATE calendar_connections
             SET next_sync_at = clock_timestamp() + (${leaseMs}::int * interval '1 millisecond')
           WHERE id = ${id}::uuid AND org_id = ${organizationId}::uuid AND status = 'active'
             AND (next_sync_at IS NULL OR next_sync_at <= clock_timestamp())
          RETURNING next_sync_at`,
      );
      const lease = rows[0]?.next_sync_at;
      return lease ? { lease } : null;
    },

    /**
     * Permanent failure (grant gone): the UI asks the user to reconnect. With `lease`, it only writes while the
     * sweep's claim is still held (returns false otherwise), so a sweep whose claim expired and was re-taken cannot
     * mark a connection that a newer sweep just synced.
     */
    async markError(
      organizationId: string,
      id: string,
      opts: { lease?: Date } = {},
    ): Promise<boolean> {
      if (!UUID_RE.test(id)) return false;
      const r = await run(organizationId, (tx) =>
        tx.calendarConnection.updateMany({
          where: {
            id,
            organizationId,
            status: 'active',
            ...(opts.lease ? { nextSyncAt: opts.lease } : {}),
          },
          data: { status: 'error' },
        }),
      );
      return r.count === 1;
    },

    /**
     * Transient failure: bump the failure count and push the next attempt out (backoff computed by the caller).
     * `retryInMs` is applied to the database clock at write time. With `lease`, it only writes while the claim
     * is still held (returns false otherwise).
     */
    async recordFailure(
      organizationId: string,
      id: string,
      s: { syncFailures: number; nextSyncAt?: Date; retryInMs?: number; lease?: Date },
    ): Promise<boolean> {
      if (!UUID_RE.test(id)) return false;
      const failures = Math.max(0, Math.trunc(s.syncFailures) || 0);
      if (s.retryInMs !== undefined) {
        const ms = Math.max(0, Math.trunc(s.retryInMs) || 0);
        const n = await run(
          organizationId,
          (tx) => tx.$executeRaw`
            UPDATE calendar_connections
               SET sync_failures = ${failures}::int,
                   next_sync_at = clock_timestamp() + (${ms}::int * interval '1 millisecond')
             WHERE id = ${id}::uuid AND org_id = ${organizationId}::uuid AND status <> 'revoked'
               AND (${s.lease ?? null}::timestamptz IS NULL OR next_sync_at = ${s.lease ?? null}::timestamptz)`,
        );
        return n === 1;
      }
      if (!s.nextSyncAt) throw new Error('recordFailure needs nextSyncAt or retryInMs');
      const nextSyncAt = s.nextSyncAt;
      const r = await run(organizationId, (tx) =>
        tx.calendarConnection.updateMany({
          where: {
            id,
            organizationId,
            status: { not: 'revoked' },
            ...(s.lease ? { nextSyncAt: s.lease } : {}),
          },
          data: { syncFailures: failures, nextSyncAt },
        }),
      );
      return r.count === 1;
    },

    /**
     * Applies one sync of [from, to) atomically: upserts every event, and when the provider list was complete
     * (not truncated) soft-cancels stored events in the window that the provider no longer returns. Then advances
     * the cursor (window, last_synced_at, failures reset, next due time). Skips silently if the connection is no
     * longer active (revoked mid-sweep) or, with `lease`, if the claim was lost (lease expired and re-claimed): the
     * row is locked FOR UPDATE first, so nothing is written for a lost claim. `nextSyncInMs` is applied to the
     * database clock at commit time (takes precedence over `nextSyncAt`).
     */
    async applySync(
      organizationId: string,
      input: {
        connectionId: string;
        from: Date;
        to: Date;
        events: CalendarSyncEventInput[];
        complete: boolean;
        now: Date;
        nextSyncAt?: Date;
        nextSyncInMs?: number;
        lease?: Date;
      },
    ): Promise<{ upserted: number; cancelled: number; applied: boolean }> {
      const { connectionId, from, to, now } = input;
      if (!UUID_RE.test(connectionId) || !(to > from)) throw new Error('invalid sync input');
      if (input.nextSyncAt === undefined && input.nextSyncInMs === undefined)
        throw new Error('invalid sync input');
      return run(organizationId, async (tx) => {
        if (input.lease) {
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM calendar_connections
             WHERE id = ${connectionId}::uuid AND org_id = ${organizationId}::uuid AND status = 'active'
               AND next_sync_at = ${input.lease}::timestamptz
             FOR UPDATE`;
          if (held.length === 0) return { upserted: 0, cancelled: 0, applied: false };
        }
        const conn = await tx.calendarConnection.findFirst({
          where: { id: connectionId, organizationId, status: 'active' },
          select: { userId: true, provider: true },
        });
        if (!conn) return { upserted: 0, cancelled: 0, applied: false };
        const seen = new Set<string>();
        let upserted = 0;
        for (const e of input.events) {
          const startsAt = new Date(e.startsAt);
          const endsAt = new Date(e.endsAt);
          if (
            !e.id ||
            e.id.length > 1024 ||
            seen.has(e.id) ||
            Number.isNaN(startsAt.getTime()) ||
            Number.isNaN(endsAt.getTime()) ||
            endsAt < startsAt ||
            !STATUSES.has(e.status)
          )
            continue;
          seen.add(e.id);
          const data = {
            title: e.title.slice(0, 1024),
            startsAt,
            endsAt,
            allDay: e.allDay,
            conferenceUrl: HTTPS(e.conferenceUrl),
            htmlLink: HTTPS(e.htmlLink),
            organizerEmail: e.organizerEmail?.slice(0, 320) ?? null,
            attendeeCount: Math.max(0, Math.trunc(e.attendeeCount) || 0),
            status: e.status,
            syncedAt: now,
          };
          await tx.calendarEvent.upsert({
            where: {
              organizationId_connectionId_providerEventId: {
                organizationId,
                connectionId,
                providerEventId: e.id,
              },
            },
            create: {
              id: randomUUID(),
              organizationId,
              connectionId,
              userId: conn.userId,
              provider: conn.provider,
              providerEventId: e.id,
              ...data,
            },
            update: data,
          });
          upserted++;
        }
        let cancelled = 0;
        if (input.complete) {
          const r = await tx.calendarEvent.updateMany({
            where: {
              organizationId,
              connectionId,
              startsAt: { gte: from, lt: to },
              status: { not: 'cancelled' },
              providerEventId: { notIn: [...seen] },
            },
            data: { status: 'cancelled', syncedAt: now },
          });
          cancelled = r.count;
        }
        await tx.calendarConnection.updateMany({
          where: { id: connectionId, organizationId, status: 'active' },
          data: {
            lastSyncedAt: now,
            syncedFrom: from,
            syncedTo: to,
            syncFailures: 0,
            ...(input.nextSyncAt ? { nextSyncAt: input.nextSyncAt } : {}),
          },
        });
        if (input.nextSyncInMs !== undefined) {
          const ms = Math.max(0, Math.trunc(input.nextSyncInMs) || 0);
          await tx.$executeRaw`
            UPDATE calendar_connections
               SET next_sync_at = clock_timestamp() + (${ms}::int * interval '1 millisecond')
             WHERE id = ${connectionId}::uuid AND org_id = ${organizationId}::uuid AND status = 'active'`;
        }
        return { upserted, cancelled, applied: true };
      });
    },

    /** The window last fully synced for the user's active connection, or null (never synced / not theirs). */
    async coverage(
      organizationId: string,
      userId: string,
      connectionId: string,
    ): Promise<CalendarSyncCoverage | null> {
      if (!UUID_RE.test(connectionId) || !UUID_RE.test(userId)) return null;
      const r = await run(organizationId, (tx) =>
        tx.calendarConnection.findFirst({
          where: { id: connectionId, organizationId, userId, status: 'active' },
          select: { syncedFrom: true, syncedTo: true, lastSyncedAt: true },
        }),
      );
      if (!r?.syncedFrom || !r.syncedTo || !r.lastSyncedAt) return null;
      return { from: r.syncedFrom, to: r.syncedTo, lastSyncedAt: r.lastSyncedAt };
    },

    /** Stored, non-cancelled events of the user's connection overlapping [from, to), by start time. */
    async listEvents(
      organizationId: string,
      userId: string,
      connectionId: string,
      from: Date,
      to: Date,
      limit = 250,
    ): Promise<CalendarSyncedEvent[]> {
      if (!UUID_RE.test(connectionId) || !UUID_RE.test(userId)) return [];
      const rows = await run(organizationId, (tx) =>
        tx.calendarEvent.findMany({
          where: {
            organizationId,
            userId,
            connectionId,
            status: { not: 'cancelled' },
            startsAt: { lt: to },
            endsAt: { gt: from },
          },
          orderBy: [{ startsAt: 'asc' }, { providerEventId: 'asc' }],
          take: Math.min(Math.max(limit, 1), 500),
        }),
      );
      return rows.map((r) => ({
        id: r.providerEventId,
        connectionId: r.connectionId,
        provider: r.provider,
        title: r.title,
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        allDay: r.allDay,
        ...(r.conferenceUrl ? { conferenceUrl: r.conferenceUrl } : {}),
        ...(r.htmlLink ? { htmlLink: r.htmlLink } : {}),
        ...(r.organizerEmail ? { organizerEmail: r.organizerEmail } : {}),
        attendeeCount: r.attendeeCount,
        status: r.status as CalendarSyncEventInput['status'],
      }));
    },
  };
}

export type CalendarSyncRepository = ReturnType<typeof createCalendarSyncRepository>;
