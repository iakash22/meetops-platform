import type { ConsentRepository } from '../domain/consent.js';
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
}

export interface ReconcileResult {
  organizations: number;
  uploads: number;
  skipped: number;
}

/**
 * #302 M-1 reconciler: re-enqueues stale `processing/pending` uploads with their deterministic job id (BullMQ keeps
 * one job per id, so a subject that still has a job is untouched). Subjects without a valid stored consent are
 * skipped (they never get a job). Safe to run repeatedly / concurrently.
 */
export async function reconcileStaleMedia(d: {
  store: StaleMediaStore;
  consents: ConsentRepository;
  jobs: MediaJobQueue;
  now: () => Date;
  olderThanMs: number;
  limitPerOrg?: number;
}): Promise<ReconcileResult> {
  const before = new Date(d.now().getTime() - d.olderThanMs);
  const limit = d.limitPerOrg ?? 500;
  const out: ReconcileResult = { organizations: 0, uploads: 0, skipped: 0 };
  for (const org of await d.store.organizationIds()) {
    out.organizations++;
    for (const u of await d.store.staleUploads(org, before, limit)) {
      let consentId: string;
      try {
        consentId = checkStoredConsent(await d.consents.findLatest(org, 'upload', u.id)).id;
      } catch {
        out.skipped++;
        continue;
      }
      await d.jobs.enqueue({
        kind: 'process_upload',
        organizationId: org,
        subjectType: 'upload',
        subjectId: u.id,
        consentAttestationId: consentId,
        ...(u.meetingId ? { meetingId: u.meetingId } : {}),
      });
      out.uploads++;
    }
  }
  return out;
}
