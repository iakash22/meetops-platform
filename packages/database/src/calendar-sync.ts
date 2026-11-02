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
  /** Incremental cursor (decrypted) and the window its round was opened for; null = none / undecryptable. */
  syncCursor: CalendarSyncCursor | null;
  /** Token-write generation read with these secrets; pass it to updateTokens for its compare-and-set. */
  tokenGeneration: number;
  /** AAD context version the stored refresh token was sealed under (1 = pre-v2, 2 = per-field); null = none. */
  refreshEncVersion: 1 | 2 | null;
}

export interface CalendarSyncCursor {
  value: string;
  from: Date;
  to: Date;
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

const MAX_EXTERNAL_ID_LEN = 255;

/**
 * Calendar auto-link, inside applySync's org-scoped (forced RLS) transaction. For each candidate event that is live in
 * this sync (not cancelled) and whose externalMeetingId matches exactly ONE live meeting of the organization (the
 * same rule as the API's suggestedMeetingId), insert a link with source='auto' unless ANY row already exists for
 * (connection, event): a manual link, an earlier auto link, or a link a user removed (unlinked_at set). ON CONFLICT
 * DO NOTHING makes it idempotent and race-safe against a concurrent manual link. Each inserted link writes one
 * audit_events row (action calendar.link, actor_type system, target the connection), like the API's manual link.
 */
async function autoLinkInTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  connectionId: string,
  userId: string,
  candidates: { eventId: string; externalMeetingId: string }[],
  live: Set<string>,
): Promise<number> {
  const byEvent = new Map<string, string>();
  for (const c of candidates)
    if (
      live.has(c.eventId) &&
      c.externalMeetingId &&
      c.externalMeetingId.length <= MAX_EXTERNAL_ID_LEN &&
      !byEvent.has(c.eventId)
    )
      byEvent.set(c.eventId, c.externalMeetingId);
  if (byEvent.size === 0) return 0;
  const ext = [...new Set(byEvent.values())];
  const rows = await tx.meeting.findMany({
    where: { organizationId, deletedAt: null, externalMeetingId: { in: ext } },
    select: { id: true, externalMeetingId: true },
    take: ext.length * 4,
  });
  const seen = new Map<string, string | null>();
  for (const r of rows)
    if (r.externalMeetingId)
      seen.set(r.externalMeetingId, seen.has(r.externalMeetingId) ? null : r.id);
  const audits: Prisma.AuditEventCreateManyInput[] = [];
  for (const [eventId, x] of byEvent) {
    const meetingId = seen.get(x);
    if (!meetingId) continue; // no match, or ambiguous (two or more live meetings share the id)
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO calendar_event_links
        (id, org_id, connection_id, user_id, provider_event_id, meeting_id, source, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${organizationId}::uuid, ${connectionId}::uuid, ${userId}::uuid, ${eventId},
              ${meetingId}::uuid, 'auto', now(), now())
      ON CONFLICT (org_id, connection_id, provider_event_id) DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) continue;
    audits.push({
      organizationId,
      actorId: null,
      actorType: 'system',
      action: 'calendar.link',
      targetType: 'calendar_connection',
      targetId: connectionId,
      metadata: { meetingId, source: 'auto' },
    });
  }
  // createMany (no RETURNING): audit_events is insert-only for the app role.
  if (audits.length) await tx.auditEvent.createMany({ data: audits });
  return audits.length;
}

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
  const ctx = (organizationId: string, id: string, field: 'access' | 'refresh' | 'cursor') => ({
    organizationId,
    integrationId: `calendar:${id}:${field}`,
  });
  const open = async (
    organizationId: string,
    id: string,
    enc: string,
    field: 'access' | 'refresh',
    only?: 1 | 2,
  ): Promise<{ value: string; legacy: boolean } | null> => {
    if (only === 1)
      return cipher()
        .decrypt(enc, { organizationId, integrationId: id })
        .then((value) => ({ value, legacy: true }))
        .catch(() => null);
    try {
      return { value: await cipher().decrypt(enc, ctx(organizationId, id, field)), legacy: false };
    } catch {
      try {
        return {
          value: await cipher().decrypt(enc, { organizationId, integrationId: id }),
          legacy: true,
        };
      } catch {
        return null;
      }
    }
  };
  // A declared version 2 never falls back to the pre-v2 context (open() tries v2 first, so check the result).
  const openRefresh = async (organizationId: string, id: string, enc: string, v: number | null) => {
    const r = await open(organizationId, id, enc, 'refresh', v === 1 ? 1 : undefined);
    return r && v === 2 && r.legacy ? null : r;
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
            syncCursorEnc: true,
            syncCursorFrom: true,
            syncCursorTo: true,
            tokenGeneration: true,
            refreshEncVersion: true,
          },
        }),
      );
      if (!row?.accessTokenEnc) return null;
      const access = await open(organizationId, id, row.accessTokenEnc, 'access');
      if (access === null) return null;
      const declared = row.refreshEncVersion ?? null;
      const refresh = row.refreshTokenEnc
        ? await openRefresh(organizationId, id, row.refreshTokenEnc, declared)
        : null;
      // The refresh token must open under its declared context (refresh_enc_version). Rows written before that
      // column (NULL) only accept the shared pre-v2 context when the whole row is legacy: a v2 access token next
      // to an undeclared legacy-only refresh token means an envelope was moved between columns.
      const accessToken = access.value;
      const refreshToken =
        refresh && (declared !== null || !refresh.legacy || access.legacy) ? refresh.value : null;
      let syncCursor: CalendarSyncCursor | null = null;
      if (row.syncCursorEnc && row.syncCursorFrom && row.syncCursorTo) {
        // Cursor AAD only (no pre-v2 fallback: cursors postdate per-field AAD). Undecryptable = start a new round.
        const value = await cipher()
          .decrypt(row.syncCursorEnc, ctx(organizationId, id, 'cursor'))
          .catch(() => null);
        if (value) syncCursor = { value, from: row.syncCursorFrom, to: row.syncCursorTo };
      }
      return {
        syncCursor,
        userId: row.userId,
        provider: row.provider,
        accessToken,
        refreshToken,
        accessTokenExpiresAt: row.accessTokenExpiresAt,
        syncFailures: row.syncFailures,
        tokenGeneration: row.tokenGeneration,
        refreshEncVersion: refreshToken === null ? null : refresh?.legacy ? 1 : 2,
      };
    },

    /**
     * Stores refreshed tokens (per-field AAD). An empty refresh token keeps the stored ciphertext (Google omits
     * it) and records the context it was read under (`refreshEncVersion` from readSecrets), so a legacy refresh
     * token stays valid next to a v2 access token. Writes only while the connection is active, with `lease` while
     * the sweep claim is still held, and with `generation` only while token_generation still equals the value
     * readSecrets returned (compare-and-set; the write bumps it). A reconnect bumps the generation and clears the
     * lease, so a stale refresh never overwrites the new grant or a concurrent refresh's rotated token.
     */
    async updateTokens(
      organizationId: string,
      id: string,
      t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
      opts: { lease?: Date; generation?: number; refreshEncVersion?: 1 | 2 | null } = {},
    ): Promise<boolean> {
      if (!UUID_RE.test(id)) return false;
      const accessTokenEnc = await cipher().encrypt(
        t.accessToken,
        ctx(organizationId, id, 'access'),
      );
      const keyId = ENVELOPE_RE.exec(accessTokenEnc)?.[1];
      if (!keyId) throw new Error('cipher returned a value that is not a v1 envelope');
      const refreshTokenEnc = t.refreshToken
        ? await cipher().encrypt(t.refreshToken, ctx(organizationId, id, 'refresh'))
        : undefined;
      const r = await run(organizationId, (tx) =>
        tx.calendarConnection.updateMany({
          where: {
            id,
            organizationId,
            status: 'active',
            ...(opts.lease ? { nextSyncAt: opts.lease } : {}),
            ...(opts.generation !== undefined ? { tokenGeneration: opts.generation } : {}),
          },
          data: {
            accessTokenEnc,
            ...(refreshTokenEnc
              ? { refreshTokenEnc, refreshEncVersion: 2 }
              : opts.refreshEncVersion
                ? { refreshEncVersion: opts.refreshEncVersion }
                : {}),
            tokenKeyId: keyId,
            accessTokenExpiresAt: t.accessTokenExpiresAt,
            tokenGeneration: { increment: 1 },
          },
        }),
      );
      return r.count === 1;
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
        /** Delta round: provider ids deleted since the cursor; soft-cancelled (any start time). */
        removedIds?: string[];
        /** undefined = leave the stored cursor; null = clear it; a value = store it (encrypted) for [from, to). */
        cursor?: string | null;
        /**
         * Auto-link candidates (CALENDAR_AUTO_LINK_ENABLED): provider event id -> externalMeetingId derived from its
         * conference URL. Applied in the same lease-guarded transaction; see autoLinkInTx.
         */
        autoLink?: { eventId: string; externalMeetingId: string }[];
      },
    ): Promise<{ upserted: number; cancelled: number; applied: boolean; autoLinked: number }> {
      const { connectionId, from, to, now } = input;
      if (!UUID_RE.test(connectionId) || !(to > from)) throw new Error('invalid sync input');
      if (input.nextSyncAt === undefined && input.nextSyncInMs === undefined)
        throw new Error('invalid sync input');
      if (typeof input.cursor === 'string' && (!input.cursor || input.cursor.length > 8192))
        throw new Error('invalid sync input');
      const cursorEnc =
        typeof input.cursor === 'string'
          ? await cipher().encrypt(input.cursor, ctx(organizationId, connectionId, 'cursor'))
          : input.cursor;
      return run(organizationId, async (tx) => {
        if (input.lease) {
          const held = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM calendar_connections
             WHERE id = ${connectionId}::uuid AND org_id = ${organizationId}::uuid AND status = 'active'
               AND next_sync_at = ${input.lease}::timestamptz
             FOR UPDATE`;
          if (held.length === 0)
            return { upserted: 0, cancelled: 0, applied: false, autoLinked: 0 };
        }
        const conn = await tx.calendarConnection.findFirst({
          where: { id: connectionId, organizationId, status: 'active' },
          select: { userId: true, provider: true },
        });
        if (!conn) return { upserted: 0, cancelled: 0, applied: false, autoLinked: 0 };
        const seen = new Set<string>();
        const live = new Set<string>();
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
          if (e.status !== 'cancelled') live.add(e.id);
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
        const removed = [...new Set(input.removedIds ?? [])].filter(
          (x) => x && x.length <= 1024 && !seen.has(x),
        );
        if (removed.length) {
          const r = await tx.calendarEvent.updateMany({
            where: {
              organizationId,
              connectionId,
              status: { not: 'cancelled' },
              providerEventId: { in: removed },
            },
            data: { status: 'cancelled', syncedAt: now },
          });
          cancelled += r.count;
        }
        await tx.calendarConnection.updateMany({
          where: { id: connectionId, organizationId, status: 'active' },
          data: {
            lastSyncedAt: now,
            syncedFrom: from,
            syncedTo: to,
            syncFailures: 0,
            ...(input.nextSyncAt ? { nextSyncAt: input.nextSyncAt } : {}),
            ...(cursorEnc === undefined
              ? {}
              : cursorEnc === null
                ? { syncCursorEnc: null, syncCursorFrom: null, syncCursorTo: null }
                : { syncCursorEnc: cursorEnc, syncCursorFrom: from, syncCursorTo: to }),
          },
        });
        if (input.nextSyncInMs !== undefined) {
          const ms = Math.max(0, Math.trunc(input.nextSyncInMs) || 0);
          await tx.$executeRaw`
            UPDATE calendar_connections
               SET next_sync_at = clock_timestamp() + (${ms}::int * interval '1 millisecond')
             WHERE id = ${connectionId}::uuid AND org_id = ${organizationId}::uuid AND status = 'active'`;
        }
        const autoLinked = input.autoLink?.length
          ? await autoLinkInTx(tx, organizationId, connectionId, conn.userId, input.autoLink, live)
          : 0;
        return { upserted, cancelled, applied: true, autoLinked };
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
