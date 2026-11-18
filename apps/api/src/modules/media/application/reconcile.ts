import type { ConsentRepository, ConsentVersionResolver } from '../domain/consent.js';
import { checkStoredConsent } from '../domain/consent.js';
import type { MediaJobQueue } from '../domain/ports.js';

/** A subject whose DB state says "queued" but which may have no job (the enqueue after the commit failed). */
export interface StaleMediaSubject {
  id: string;
  meetingId: string | null;
}

/** Cross-org discovery for the reconciler; each per-org query runs under that org's RLS context. */
export interface StaleMediaStore {
  organizationIds(): Promise<string[]>;
  /** Uploads in processing with scan_status pending, last updated before `before`. */
  staleUploads(organizationId: string, before: Date, limit: number): Promise<StaleMediaSubject[]>;
  /**
   * #303 backfill: recording sessions `completed` before `before` whose recording file is still `pending_upload`
   * (acked as session_assembly_pending by a pre-#303 worker, or the enqueue failed).
   */
  unassembledSessions?(
    organizationId: string,
    before: Date,
    limit: number,
  ): Promise<StaleMediaSubject[]>;
}

export interface ReconcileResult {
  organizations: number;
  uploads: number;
  sessions: number;
  skipped: number;
}

/**
 * #302 M-1 reconciler: re-queues stale `processing/pending` uploads and unassembled sessions with their deterministic job
 * id via requeue (#302 L-3: a finished job held under that id is replaced; a pending one is untouched). Counts only
 * jobs actually added. Subjects without a valid stored consent are
 * skipped (they never get a job). Safe to run repeatedly / concurrently.
 */
export async function reconcileStaleMedia(d: {
  store: StaleMediaStore;
  consents: ConsentRepository;
  /** The org's current consent version; attestations for any other version are skipped. */
  consentVersion: ConsentVersionResolver;
  jobs: MediaJobQueue;
  now: () => Date;
  olderThanMs: number;
  limitPerOrg?: number;
}): Promise<ReconcileResult> {
  const before = new Date(d.now().getTime() - d.olderThanMs);
  const limit = d.limitPerOrg ?? 500;
  const out: ReconcileResult = { organizations: 0, uploads: 0, sessions: 0, skipped: 0 };
  for (const org of await d.store.organizationIds()) {
    out.organizations++;
    const accepted = await d.consentVersion(org);
    for (const u of await d.store.staleUploads(org, before, limit)) {
      let consentId: string;
      try {
        consentId = checkStoredConsent(
          await d.consents.findLatest(org, 'upload', u.id),
          accepted,
        ).id;
      } catch {
        out.skipped++;
        continue;
      }
      const added = await d.jobs.requeue({
        kind: 'process_upload',
        organizationId: org,
        subjectType: 'upload',
        subjectId: u.id,
        consentAttestationId: consentId,
        ...(u.meetingId ? { meetingId: u.meetingId } : {}),
      });
      if (added) out.uploads++;
    }
    for (const s of (await d.store.unassembledSessions?.(org, before, limit)) ?? []) {
      let consentId: string;
      try {
        consentId = checkStoredConsent(
          await d.consents.findLatest(org, 'recording_session', s.id),
          accepted,
        ).id;
      } catch {
        out.skipped++;
        continue;
      }
      const job = {
        kind: 'process_recording_session' as const,
        organizationId: org,
        subjectType: 'recording_session' as const,
        subjectId: s.id,
        consentAttestationId: consentId,
        ...(s.meetingId ? { meetingId: s.meetingId } : {}),
      };
      // The acked pre-#303 job is kept by removeOnComplete: requeue drops a finished job with the same id, then adds.
      // A job still waiting/active is left alone, so reruns stay at one job per session.
      if (await d.jobs.requeue(job)) out.sessions++;
    }
  }
  return out;
}
