import { randomUUID } from 'node:crypto';
import {
  isSafeUploadFilename,
  MAX_PRESIGNED_GET_TTL_SECONDS,
  type InitUploadRequest,
} from '@meetops/contracts';
import { DomainError } from '../../../shared/domain-error.js';
import type { DirectoryCaller } from '../../directory/access.js';
import type { MeetingRepository } from '../../meetings/domain/meeting.js';
import { MeetingNotFoundError } from '../../meetings/domain/meeting.js';
import {
  checkConsentInput,
  checkStoredConsent,
  type ConsentRepository,
} from '../domain/consent.js';
import { enforceMeetingConsent, type MeetingConsentGate } from '../domain/meeting-consent.js';
import {
  UploadNotFoundError,
  UploadStateConflictError,
  type FileObjectRecord,
  type FileObjectRepository,
  type MediaJobQueue,
  type MediaProcessingJob,
  type MediaSigner,
  type SignedRequest,
} from '../domain/ports.js';
import { authorizeMedia } from './media-access.js';

/**
 * Lifetime of the presigned upload PUT. Must stay within the storage signer's MAX_PRESIGN_TTL_SECONDS (600 s);
 * 300 s matches the chunk and download URLs (#300 M-1).
 */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** Download URLs: never above contracts MAX_PRESIGNED_GET_TTL_SECONDS (300 s). */
export const DOWNLOAD_URL_TTL_SECONDS = Math.min(300, MAX_PRESIGNED_GET_TTL_SECONDS);

export interface MediaDeps extends MeetingConsentGate {
  files: FileObjectRepository;
  consents: ConsentRepository;
  signer: MediaSigner;
  jobs: MediaJobQueue;
  meetings: MeetingRepository;
  now: () => Date;
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export type InitUploadInput = Omit<InitUploadRequest, 'consent'> & { consent?: unknown };

/** Uploads use cases. Order: tenant (404) -> CASL (403) -> consent (422) -> storage. */
export class UploadService {
  constructor(private readonly d: MediaDeps) {}

  async init(
    c: DirectoryCaller,
    body: InitUploadInput,
  ): Promise<{ file: FileObjectRecord; upload: SignedRequest }> {
    authorizeMedia(c, 'create', 'FileObject');
    // The schema pattern covers BMP characters; this also rejects astral format/control code points (#270 L-1).
    if (!isSafeUploadFilename(body.filename))
      throw new DomainError('VALIDATION_FAILED', 'Invalid filename', 400);
    const now = this.d.now();
    const org = c.ctx.organizationId;
    const consent = checkConsentInput(body.consent, now, await this.d.consentVersion(org));
    if (body.meetingId) {
      const m = isUuid(body.meetingId) ? await this.d.meetings.findById(org, body.meetingId) : null;
      if (!m) throw new MeetingNotFoundError();
    }
    // CONSENT_ENFORCEMENT_ENABLED: an upload with no meeting, or a meeting without a current grant, fails closed.
    await enforceMeetingConsent(this.d, org, body.meetingId);
    const id = randomUUID();
    const file: FileObjectRecord = {
      id,
      organizationId: org,
      meetingId: body.meetingId ?? null,
      uploadedById: c.ctx.userId,
      key: `organizations/${org}/uploads/${id}/source`,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      checksumSha256Base64: body.checksumSha256,
      originalName: body.filename,
      status: 'pending_upload',
      scanStatus: null,
      createdAt: now,
    };
    // #300 M-1/L-1: sign first (no I/O, fails without side effects), then persist the file row and its consent
    // attestation atomically, so a signer or DB failure leaves no orphan pending_upload row or attestation.
    const upload = await this.d.signer.presignPut({
      key: file.key,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksumSha256Base64: file.checksumSha256Base64,
      ttlSeconds: UPLOAD_URL_TTL_SECONDS,
    });
    const attestation = {
      organizationId: org,
      subjectType: 'upload' as const,
      subjectId: id,
      consentVersion: consent.consentVersion,
      method: consent.method,
      attestedByUserId: c.ctx.userId,
      attestedAt: new Date(consent.attestedAt),
      recordedAt: now,
    };
    if (this.d.files.createWithConsent) {
      await this.d.files.createWithConsent(file, attestation);
    } else {
      await this.d.files.create(file);
      await this.d.consents.record(attestation);
    }
    return { file, upload };
  }

  private async find(c: DirectoryCaller, id: string) {
    const f = isUuid(id) ? await this.d.files.findById(c.ctx.organizationId, id) : null;
    if (!f) throw new UploadNotFoundError();
    return f;
  }

  /** Queues processing only when the object is stored and a valid consent attestation is on record. */
  async complete(c: DirectoryCaller, id: string): Promise<FileObjectRecord> {
    const f = await this.find(c, id);
    authorizeMedia(c, 'update', 'FileObject', f.uploadedById);
    if (f.status === 'processing' && f.scanStatus === 'pending') {
      // #302 M-1: the status commit happened but the enqueue may have failed. A replay re-enqueues with the same
      // deterministic job id (a no-op while that job exists), so the upload can never be stuck in processing.
      const consent = checkStoredConsent(
        await this.d.consents.findLatest(f.organizationId, 'upload', f.id),
        await this.d.consentVersion(f.organizationId),
      );
      await enforceMeetingConsent(this.d, f.organizationId, f.meetingId);
      await this.enqueue(f, consent.id, true);
      return { ...f };
    }
    if (f.status !== 'pending_upload')
      throw new UploadStateConflictError('Upload already completed');
    // #168 order: stored size/checksum first, then the stored consent attestation.
    const stored = await this.d.signer.head(f.key);
    if (!stored) throw new UploadStateConflictError('The file has not been uploaded yet');
    if (stored.sizeBytes !== f.sizeBytes) {
      throw new UploadStateConflictError('Uploaded size does not match the declared size');
    }
    // Fail closed: no checksum, a multipart composite (`<b64>-<parts>`) or a different digest all mean the stored
    // bytes are not provably the ones declared at init.
    if (stored.checksumSha256Base64 !== f.checksumSha256Base64) {
      throw new UploadStateConflictError('Uploaded checksum does not match the declared checksum');
    }
    const consent = checkStoredConsent(
      await this.d.consents.findLatest(f.organizationId, 'upload', f.id),
      await this.d.consentVersion(f.organizationId),
    );
    await enforceMeetingConsent(this.d, f.organizationId, f.meetingId);
    await this.d.files.setStatus(f.organizationId, f.id, 'processing', 'pending');
    await this.enqueue(f, consent.id);
    return { ...f, status: 'processing', scanStatus: 'pending' };
  }

  /** `replay` (#302 L-3): requeue, so a finished job held under the id is replaced. */
  private async enqueue(
    f: FileObjectRecord,
    consentAttestationId: string,
    replay = false,
  ): Promise<void> {
    const job = {
      kind: 'process_upload',
      organizationId: f.organizationId,
      subjectType: 'upload',
      subjectId: f.id,
      consentAttestationId,
      ...(f.meetingId ? { meetingId: f.meetingId } : {}),
    } satisfies MediaProcessingJob;
    await (replay ? this.d.jobs.requeue(job) : this.d.jobs.enqueue(job));
  }

  /**
   * Per #168: 404 (same body as other-org / unknown ids) unless the FileObject's scanStatus is `clean`.
   * Security review B 4.4: the CASL check runs against this row (org + uploader), not just the subject type, so a
   * row-level rule in the RBAC matrix (e.g. private recordings) applies here. The current matrix grants `read
   * FileObject` org-wide to every role.
   */
  async downloadUrl(c: DirectoryCaller, id: string): Promise<SignedRequest> {
    const f = await this.find(c, id);
    authorizeMedia(c, 'read', 'FileObject', f.uploadedById);
    if (f.scanStatus !== 'clean') throw new UploadNotFoundError();
    return this.d.signer.presignGet({
      key: f.key,
      ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
      contentType: f.mimeType,
    });
  }
}
