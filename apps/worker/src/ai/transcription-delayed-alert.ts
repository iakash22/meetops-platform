import {
  withOrganizationContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@meetops/database';
import {
  TRANSCRIPTION_DELAYED_EVENT,
  TRANSCRIPTION_DELAYED_OWNER_EVENT,
} from '@meetops/notifications';
import type { TranscriptionDeadLetter, TranscriptionDelayedAlert } from './transcription-retry.js';

/** Outbox writes used by the alert (Prisma in production, a fake in tests). */
export type DelayedAlertStore = {
  meetingCreator(meetingId: string): Promise<string | null | undefined>;
  /**
   * Atomic insert-once: writes the event unless one with the same `dedupeKey` exists for the org (unique
   * (org_id, dedupe_key), INSERT ... ON CONFLICT DO NOTHING). Returns true when this call wrote it.
   */
  writeEventOnce(e: {
    aggregateType: 'meeting' | 'user';
    aggregateId: string;
    eventType: string;
    payload: Record<string, string>;
    dedupeKey: string;
  }): Promise<boolean>;
};

/** One alert per event type, recipient aggregate, recording and UTC day. */
export const delayedAlertDedupeKey = (
  eventType: string,
  aggregateId: string,
  recordingId: string,
  day: string,
) => `${eventType}/${aggregateId}/${recordingId}/${day}`;

const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * ADR-013 path: write `meeting.transcription_delayed` (org owners/admins) and, when the meeting has a creator,
 * `meeting.transcription_delayed.owner` (that user) to the outbox; the relay fans them out as one
 * `meeting.transcription_delayed` notification per user. Duplicates are stopped twice: an atomic insert-once per
 * recording and UTC day (unique (org_id, dedupe_key), no check-then-write race), and the shared notification dedupe key at fan-out. Ids and codes only.
 */
export async function writeTranscriptionDelayedEvents(
  store: DelayedAlertStore,
  d: TranscriptionDeadLetter,
): Promise<{ written: string[] }> {
  const day = d.failedAt.slice(0, 10);
  const payload = {
    meetingId: d.meetingId,
    recordingId: d.recordingId,
    errorCode: ERROR_CODE_RE.test(d.errorCode) ? d.errorCode : 'provider_unavailable',
    failedAt: d.failedAt,
  };
  const written: string[] = [];
  if (
    await store.writeEventOnce({
      aggregateType: 'meeting',
      aggregateId: d.meetingId,
      eventType: TRANSCRIPTION_DELAYED_EVENT,
      payload,
      dedupeKey: delayedAlertDedupeKey(TRANSCRIPTION_DELAYED_EVENT, d.meetingId, d.recordingId, day),
    })
  )
    written.push(TRANSCRIPTION_DELAYED_EVENT);
  const creator = await store.meetingCreator(d.meetingId);
  if (
    creator &&
    (await store.writeEventOnce({
      aggregateType: 'user',
      aggregateId: creator,
      eventType: TRANSCRIPTION_DELAYED_OWNER_EVENT,
      payload,
      dedupeKey: delayedAlertDedupeKey(TRANSCRIPTION_DELAYED_OWNER_EVENT, creator, d.recordingId, day),
    }))
  )
    written.push(TRANSCRIPTION_DELAYED_OWNER_EVENT);
  return { written };
}

export function createPrismaDelayedAlertStore(
  tx: DatabaseTransaction,
  organizationId: string,
): DelayedAlertStore {
  return {
    async meetingCreator(meetingId) {
      const m = await tx.meeting.findFirst({
        where: { id: meetingId, organizationId, deletedAt: null },
        select: { createdById: true },
      });
      return m?.createdById;
    },
    async writeEventOnce(e) {
      // INSERT ... ON CONFLICT DO NOTHING on the (org_id, dedupe_key) unique index: atomic under concurrency, and
      // no JSON payload lookup (the old check-then-write scanned payload->recordingId without an index).
      const r = await tx.outboxEvent.createMany({
        data: [{ organizationId, ...e }],
        skipDuplicates: true,
      });
      return r.count === 1;
    },
  };
}

/** `onTranscriptionDelayed` hook for the transcription worker: one org-scoped transaction (forced RLS). */
export function createOutboxTranscriptionDelayedAlert(
  opts: { client?: DatabaseClient } = {},
): TranscriptionDelayedAlert {
  return async (d) => {
    await withOrganizationContext(
      d.organizationId,
      (tx) =>
        writeTranscriptionDelayedEvents(createPrismaDelayedAlertStore(tx, d.organizationId), d),
      opts.client ? { client: opts.client } : {},
    );
  };
}
