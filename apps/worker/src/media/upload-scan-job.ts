import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FileObjectScanStatus } from '@meetops/contracts';
import {
  scanUploadObject,
  type UploadObjectSource,
  type UploadProbe,
  type UploadScanLimits,
  type UploadScanResult,
} from './upload-scan.js';
import type { Antivirus } from './clamd.js';
import type { UploadStatusEvent } from './types.js';

const Uuid = Type.String({ format: 'uuid' });

/**
 * The job the API enqueues on upload complete (`apps/api` `MediaProcessingJob`, kind `process_upload`). Mirrored here
 * until it moves to @meetops/contracts: the contracts `MediaJobPayload` covers recordings only.
 */
export const UploadScanJob = Type.Object(
  {
    kind: Type.Literal('process_upload'),
    organizationId: Uuid,
    subjectType: Type.Literal('upload'),
    subjectId: Uuid,
    consentAttestationId: Uuid,
    meetingId: Type.Optional(Uuid),
  },
  { additionalProperties: false },
);
export type UploadScanJob = Static<typeof UploadScanJob>;

/** The FileObject fields the scan needs, read under the job's org (forced RLS). */
export type ScannableUpload = {
  id: string;
  key: string;
  mimeType: string;
  scanStatus: FileObjectScanStatus | null;
};

export type UploadScanDeps = {
  /** Org-scoped lookup (runs under withOrganizationContext); null for unknown or other-org ids. */
  findUpload(organizationId: string, id: string): Promise<ScannableUpload | null>;
  /**
   * Sets scanStatus only while it is still `pending` (idempotent, so retries can't flip a decided row). Runs under
   * withOrganizationContext.
   */
  setScanStatus(
    organizationId: string,
    id: string,
    status: Exclude<FileObjectScanStatus, 'pending'>,
  ): Promise<void>;
  /** Object reader for a stored key (HEAD size + streaming body). */
  source(key: string, ids: { organizationId: string; uploadId: string }): UploadObjectSource;
  probe: UploadProbe;
  /** Optional realtime `upload:status` (only when the upload belongs to a meeting: rooms are meeting-scoped). */
  publishUploadStatus?(e: UploadStatusEvent): void;
  limits?: Partial<UploadScanLimits>;
  tmpRoot?: string;
  /** Optional ClamAV (clamd); fail-closed when set. */
  antivirus?: Antivirus;
  now?: () => Date;
};

export type UploadScanOutcome =
  | { status: 'skipped'; reason: 'invalid_job' | 'not_found' | 'already_scanned' }
  | {
      status: 'clean' | 'quarantined';
      result: UploadScanResult | { verdict: 'error'; code: 'scan_unavailable' };
    };

/**
 * Worker handler for `process_upload`: the only place that moves an upload's scanStatus off `pending`. `clean` only
 * when scanUploadObject (magic bytes, ffprobe, decoded-size caps) says so; any failed check sets `quarantined`, so
 * GET .../download-url keeps returning 404. Infrastructure errors (storage, DB) propagate so BullMQ retries.
 */
export async function processUploadScan(
  job: unknown,
  deps: UploadScanDeps,
  ctx: { isFinalAttempt: boolean } = { isFinalAttempt: true },
): Promise<UploadScanOutcome> {
  if (!Value.Check(UploadScanJob, job)) return { status: 'skipped', reason: 'invalid_job' };
  const { organizationId, subjectId, meetingId } = job;
  const f = await deps.findUpload(organizationId, subjectId);
  if (!f) return { status: 'skipped', reason: 'not_found' };
  if (f.scanStatus !== null && f.scanStatus !== 'pending')
    return { status: 'skipped', reason: 'already_scanned' };
  const publish = (errorCode: string | undefined) => {
    if (!meetingId || !deps.publishUploadStatus) return;
    deps.publishUploadStatus({
      organizationId,
      meetingId,
      uploadId: subjectId,
      status: errorCode === undefined ? 'verified' : 'failed',
      ...(errorCode !== undefined ? { errorCode } : {}),
      at: (deps.now ?? (() => new Date()))().toISOString(),
    });
  };

  let result: UploadScanResult;
  try {
    result = await scanUploadObject(
      deps.source(f.key, { organizationId, uploadId: subjectId }),
      f.mimeType,
      deps.probe,
      {
        ...(deps.limits ? { limits: deps.limits } : {}),
        ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
        ...(deps.antivirus ? { antivirus: deps.antivirus } : {}),
      },
    );
  } catch (err) {
    // Infra errors (storage, ffprobe, clamd) retry; once attempts are exhausted the upload is quarantined so it never
    // stays pending forever (M-3).
    if (!ctx.isFinalAttempt) throw err;
    await deps.setScanStatus(organizationId, subjectId, 'quarantined');
    publish('scan_unavailable');
    return { status: 'quarantined', result: { verdict: 'error', code: 'scan_unavailable' } };
  }
  // M-3: any failed check quarantines (kept, never served or processed); only `clean` may be downloaded.
  const status = result.verdict === 'clean' ? 'clean' : 'quarantined';
  await deps.setScanStatus(organizationId, subjectId, status);
  publish(result.verdict === 'rejected' ? result.code : undefined);
  return { status, result };
}
