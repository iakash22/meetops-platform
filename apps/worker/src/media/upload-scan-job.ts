import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { UploadScanJobPayload, type FileObjectScanStatus } from '@meetops/contracts';
import {
  scanUploadObject,
  type UploadObjectSource,
  type UploadProbe,
  type UploadScanLimits,
  type UploadScanResult,
} from './upload-scan.js';
import type { UploadStatusEvent } from './types.js';

/** The job the API enqueues on upload complete: contracts `UploadScanJobPayload` (kind `process_upload`). */
export const UploadScanJob = UploadScanJobPayload;
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
  source(key: string): UploadObjectSource;
  probe: UploadProbe;
  /** Optional realtime `upload:status` (only when the upload belongs to a meeting: rooms are meeting-scoped). */
  publishUploadStatus?(e: UploadStatusEvent): void;
  limits?: Partial<UploadScanLimits>;
  tmpRoot?: string;
  now?: () => Date;
};

export type UploadScanOutcome =
  | { status: 'skipped'; reason: 'invalid_job' | 'not_found' | 'already_scanned' }
  | { status: 'clean' | 'rejected'; result: UploadScanResult };

/**
 * Worker handler for `process_upload`: the only place that moves an upload's scanStatus off `pending`. `clean` only
 * when scanUploadObject (magic bytes, ffprobe, decoded-size caps) says so; any rejection sets `rejected`, so
 * GET .../download-url keeps returning 404. Infrastructure errors (storage, DB) propagate so BullMQ retries.
 */
export async function processUploadScan(
  job: unknown,
  deps: UploadScanDeps,
): Promise<UploadScanOutcome> {
  if (!Value.Check(UploadScanJob, job)) return { status: 'skipped', reason: 'invalid_job' };
  const { organizationId, uploadId: subjectId, meetingId } = job;
  const f = await deps.findUpload(organizationId, subjectId);
  if (!f) return { status: 'skipped', reason: 'not_found' };
  if (f.scanStatus !== null && f.scanStatus !== 'pending')
    return { status: 'skipped', reason: 'already_scanned' };

  const result = await scanUploadObject(deps.source(f.key), f.mimeType, deps.probe, {
    ...(deps.limits ? { limits: deps.limits } : {}),
    ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}),
  });
  const status = result.verdict === 'clean' ? 'clean' : 'rejected';
  await deps.setScanStatus(organizationId, subjectId, status);
  if (meetingId && deps.publishUploadStatus) {
    deps.publishUploadStatus({
      organizationId,
      meetingId,
      uploadId: subjectId,
      status: status === 'clean' ? 'verified' : 'failed',
      ...(result.verdict === 'rejected' ? { errorCode: result.code } : {}),
      at: (deps.now ?? (() => new Date()))().toISOString(),
    });
  }
  return { status, result };
}
