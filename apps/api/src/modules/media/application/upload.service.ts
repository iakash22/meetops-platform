import { randomUUID } from 'node:crypto';
import { MAX_PRESIGNED_GET_TTL_SECONDS, type InitUploadRequest } from '@meetops/contracts';
import type { DirectoryCaller } from '../../directory/access.js';
import type { MeetingRepository } from '../../meetings/domain/meeting.js';
import { MeetingNotFoundError } from '../../meetings/domain/meeting.js';
import {
  checkConsentInput,
  checkStoredConsent,
  type ConsentRepository,
} from '../domain/consent.js';
import {
  UploadNotFoundError,
  UploadStateConflictError,
  type FileObjectRecord,
  type FileObjectRepository,
  type MediaJobQueue,
  type MediaSigner,
  type SignedRequest,
} from '../domain/ports.js';
import { authorizeMedia } from './media-access.js';

/** Lifetime of the presigned upload PUT. */
export const UPLOAD_URL_TTL_SECONDS = 900;
/** Download URLs: never above contracts MAX_PRESIGNED_GET_TTL_SECONDS (300 s). */
export const DOWNLOAD_URL_TTL_SECONDS = Math.min(300, MAX_PRESIGNED_GET_TTL_SECONDS);

export interface MediaDeps {
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
    const now = this.d.now();
    const consent = checkConsentInput(body.consent, now);
    const org = c.ctx.organizationId;
    if (body.meetingId) {
      const m = isUuid(body.meetingId) ? await this.d.meetings.findById(org, body.meetingId) : null;
      if (!m) throw new MeetingNotFoundError();
    }
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
    await this.d.files.create(file);
    await this.d.consents.record({
      organizationId: org,
      subjectType: 'upload',
      subjectId: id,
      consentVersion: consent.consentVersion,
      method: consent.method,
      attestedByUserId: c.ctx.userId,
      attestedAt: new Date(consent.attestedAt),
      recordedAt: now,
    });
    const upload = await this.d.signer.presignPut({
      key: file.key,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksumSha256Base64: file.checksumSha256Base64,
      ttlSeconds: UPLOAD_URL_TTL_SECONDS,
    });
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
    );
    await this.d.files.setStatus(f.organizationId, f.id, 'processing', 'pending');
    await this.d.jobs.enqueue({
      kind: 'process_upload',
      organizationId: f.organizationId,
      subjectType: 'upload',
      subjectId: f.id,
      consentAttestationId: consent.id,
      ...(f.meetingId ? { meetingId: f.meetingId } : {}),
    });
    return { ...f, status: 'processing', scanStatus: 'pending' };
  }

  /** Per #168: 404 (same body as other-org / unknown ids) unless the FileObject's scanStatus is `clean`. */
  async downloadUrl(c: DirectoryCaller, id: string): Promise<SignedRequest> {
    const f = await this.find(c, id);
    authorizeMedia(c, 'read', 'FileObject');
    if (f.scanStatus !== 'clean') throw new UploadNotFoundError();
    return this.d.signer.presignGet({ key: f.key, ttlSeconds: DOWNLOAD_URL_TTL_SECONDS });
  }
}
