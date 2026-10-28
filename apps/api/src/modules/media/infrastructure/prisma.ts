import type { ConsentSubjectType, FileObjectScanStatus } from '@meetops/contracts';
import { sha256Base64ToHex, sha256HexToBase64 } from '@meetops/storage';
import {
  withOrganizationContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '../../../shared/prisma/context.js';
import type { ConsentRecord, ConsentRepository } from '../domain/consent.js';
import type { FileObjectRecord, FileObjectRepository, FileObjectStatus } from '../domain/ports.js';

const fileSelect = {
  id: true,
  organizationId: true,
  meetingId: true,
  uploadedById: true,
  key: true,
  mimeType: true,
  sizeBytes: true,
  checksumSha256: true,
  originalName: true,
  status: true,
  scanStatus: true,
  createdAt: true,
} as const;

interface FileRow {
  id: string;
  organizationId: string;
  meetingId: string | null;
  uploadedById: string | null;
  key: string;
  mimeType: string;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  originalName: string | null;
  status: string;
  scanStatus: string;
  createdAt: Date;
}

const API_STATUSES: readonly FileObjectStatus[] = ['pending_upload', 'uploaded', 'processing'];

function toFileRecord(r: FileRow): FileObjectRecord | null {
  // Rows the upload routes did not create (worker-derived, ready/failed) are not upload records.
  if (
    !API_STATUSES.includes(r.status as FileObjectStatus) ||
    !r.uploadedById ||
    !r.checksumSha256
  ) {
    return null;
  }
  const status = r.status as FileObjectStatus;
  return {
    id: r.id,
    organizationId: r.organizationId,
    meetingId: r.meetingId,
    uploadedById: r.uploadedById,
    key: r.key,
    mimeType: r.mimeType,
    sizeBytes: Number(r.sizeBytes ?? 0),
    checksumSha256Base64: sha256HexToBase64(r.checksumSha256),
    originalName: r.originalName ?? '',
    status,
    // DB defaults scan_status to `pending` (DB-3); the API treats it as unset until complete().
    scanStatus: status === 'pending_upload' ? null : (r.scanStatus as FileObjectScanStatus),
    createdAt: r.createdAt,
  };
}

/** file_objects (DB-3) under the organization RLS context. Checksums are hex in the DB, base64 in the API. */
export class PrismaFileObjectRepository implements FileObjectRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly bucket: string,
    private readonly provider: string,
  ) {}

  async create(r: FileObjectRecord): Promise<FileObjectRecord> {
    await withOrganizationContext(r.organizationId, (tx) => this.insertFile(tx, r), {
      client: this.client,
      userId: r.uploadedById,
    });
    return { ...r };
  }

  /** File row + consent attestation in one transaction (#300 L-1): a failure in either rolls both back. */
  async createWithConsent(
    r: FileObjectRecord,
    consent: Omit<ConsentRecord, 'id' | 'recordedAt'> & { recordedAt: Date },
  ): Promise<FileObjectRecord> {
    if (consent.organizationId !== r.organizationId || consent.subjectId !== r.id) {
      throw new Error('Consent attestation does not match the file object');
    }
    await withOrganizationContext(
      r.organizationId,
      async (tx) => {
        await this.insertFile(tx, r);
        await tx.consentAttestation.create({ data: consentData(consent), select: { id: true } });
      },
      { client: this.client, userId: r.uploadedById },
    );
    return { ...r };
  }

  private insertFile(tx: DatabaseTransaction, r: FileObjectRecord) {
    return tx.fileObject.create({
      data: {
        id: r.id,
        organizationId: r.organizationId,
        meetingId: r.meetingId,
        uploadedById: r.uploadedById,
        kind: 'raw',
        status: r.status,
        provider: this.provider,
        bucket: this.bucket,
        key: r.key,
        mimeType: r.mimeType,
        sizeBytes: BigInt(r.sizeBytes),
        checksumSha256: sha256Base64ToHex(r.checksumSha256Base64),
        originalName: r.originalName,
        createdAt: r.createdAt,
        ...(r.scanStatus ? { scanStatus: r.scanStatus } : {}),
      },
      select: { id: true },
    });
  }

  async findById(organizationId: string, id: string): Promise<FileObjectRecord | null> {
    const row = await withOrganizationContext(
      organizationId,
      (tx) =>
        tx.fileObject.findFirst({
          where: { organizationId, id, deletedAt: null },
          select: fileSelect,
        }),
      { client: this.client },
    );
    return row ? toFileRecord(row) : null;
  }

  async setStatus(
    organizationId: string,
    id: string,
    status: FileObjectStatus,
    scanStatus?: FileObjectScanStatus,
  ): Promise<void> {
    await withOrganizationContext(
      organizationId,
      (tx) =>
        tx.fileObject.updateMany({
          where: { organizationId, id },
          data: { status, ...(scanStatus ? { scanStatus } : {}) },
        }),
      { client: this.client },
    );
  }
}

const consentSelect = {
  id: true,
  organizationId: true,
  subjectType: true,
  subjectId: true,
  consentVersion: true,
  method: true,
  attestedByUserId: true,
  attestedAt: true,
  recordedAt: true,
} as const;

const consentData = (r: Omit<ConsentRecord, 'id' | 'recordedAt'> & { recordedAt: Date }) => ({
  organizationId: r.organizationId,
  subjectType: r.subjectType,
  subjectId: r.subjectId,
  consentVersion: r.consentVersion,
  method: r.method,
  attestedByUserId: r.attestedByUserId,
  attestedAt: r.attestedAt,
  recordedAt: r.recordedAt,
});

/** consent_attestations (DB-3): append-only, INSERT + SELECT only. */
export class PrismaConsentRepository implements ConsentRepository {
  constructor(private readonly client: DatabaseClient) {}

  async record(r: Omit<ConsentRecord, 'id' | 'recordedAt'> & { recordedAt: Date }) {
    const row = await withOrganizationContext(
      r.organizationId,
      (tx) =>
        tx.consentAttestation.create({
          data: consentData(r),
          select: consentSelect,
        }),
      { client: this.client, userId: r.attestedByUserId },
    );
    return row;
  }

  async findLatest(organizationId: string, subjectType: ConsentSubjectType, subjectId: string) {
    const row = await withOrganizationContext(
      organizationId,
      (tx) =>
        tx.consentAttestation.findFirst({
          where: { organizationId, subjectType, subjectId },
          orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
          select: consentSelect,
        }),
      { client: this.client },
    );
    return row ?? null;
  }
}
