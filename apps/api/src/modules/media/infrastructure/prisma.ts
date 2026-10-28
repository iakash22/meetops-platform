import type {
  AbortReason,
  ConsentSubjectType,
  FileObjectScanStatus,
  RecordingSource,
} from '@meetops/contracts';
import { randomUUID } from 'node:crypto';
import {
  buildObjectKey,
  sha256Base64ToHex,
  sha256HexToBase64,
  sourceExtForMime,
} from '@meetops/storage';
import {
  withOrganizationContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '../../../shared/prisma/context.js';
import type { ConsentRecord, ConsentRepository } from '../domain/consent.js';
import type { FileObjectRecord, FileObjectRepository, FileObjectStatus } from '../domain/ports.js';
import type {
  RecordingChunkRecord,
  RecordingSessionRecord,
  RecordingSessionRepository,
  RecordingSessionStatus,
  ReserveChunkResult,
} from '../domain/recording-session.js';
import type { StaleMediaStore, StaleMediaSubject } from '../application/reconcile.js';

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

const sessionSelect = {
  id: true,
  organizationId: true,
  meetingId: true,
  createdById: true,
  mimeType: true,
  source: true,
  startedAt: true,
  status: true,
  totalBytes: true,
  chunkCount: true,
  durationMs: true,
  abortReason: true,
  createdAt: true,
  chunks: { select: { seq: true, sizeBytes: true, sha256: true, storageKey: true } },
  recording: { select: { file: { select: { status: true } } } },
} as const;

interface SessionRow {
  id: string;
  organizationId: string;
  meetingId: string;
  createdById: string | null;
  mimeType: string;
  source: string;
  startedAt: Date;
  status: string;
  totalBytes: bigint;
  chunkCount: number | null;
  durationMs: number | null;
  abortReason: string | null;
  createdAt: Date;
  chunks: { seq: number; sizeBytes: number; sha256: string | null; storageKey: string }[];
  recording?: { file: { status: string } } | null;
}

function toSessionRecord(r: SessionRow): RecordingSessionRecord {
  return {
    id: r.id,
    organizationId: r.organizationId,
    meetingId: r.meetingId,
    createdById: r.createdById ?? '',
    mimeType: r.mimeType,
    source: r.source as RecordingSource,
    startedAt: r.startedAt,
    status: r.status as RecordingSessionStatus,
    totalBytes: Number(r.totalBytes),
    chunks: new Map(
      r.chunks.map((c) => [
        c.seq,
        { seq: c.seq, sizeBytes: c.sizeBytes, sha256Hex: c.sha256 ?? '', key: c.storageKey },
      ]),
    ),
    chunkCount: r.chunkCount,
    durationMs: r.durationMs,
    abortReason: r.abortReason as AbortReason | null,
    createdAt: r.createdAt,
    sourcePending: r.recording?.file.status === 'pending_upload',
  };
}

/**
 * Session source object key: the recording's canonical source key (organizations/{org}/meetings/{meeting}/recordings/
 * {recordingId}.{ext}), which the worker assembles from the chunks and processRecording reads.
 */
export function sessionSourceKey(
  organizationId: string,
  meetingId: string,
  recordingId: string,
  mimeType: string,
): string {
  const ext = sourceExtForMime(mimeType);
  if (!ext) throw new Error('Recording session mime type has no source extension');
  return buildObjectKey({
    organizationId,
    meetingId,
    kind: 'recording',
    objectId: recordingId,
    ext,
  });
}

/**
 * recording_sessions + recording_session_chunks (forced RLS). reserveChunk/finish lock the session row (FOR UPDATE)
 * so concurrent chunk signatures keep total_bytes exact and a session finishes once.
 */
export class PrismaRecordingSessionRepository implements RecordingSessionRepository {
  constructor(
    private readonly client: DatabaseClient,
    private readonly bucket: string,
    private readonly provider: string,
  ) {}

  async create(r: RecordingSessionRecord): Promise<void> {
    await withOrganizationContext(
      r.organizationId,
      (tx) =>
        tx.recordingSession.create({
          data: {
            id: r.id,
            organizationId: r.organizationId,
            meetingId: r.meetingId,
            createdById: r.createdById,
            mimeType: r.mimeType,
            source: r.source,
            status: r.status,
            startedAt: r.startedAt,
            totalBytes: BigInt(r.totalBytes),
            createdAt: r.createdAt,
          },
          select: { id: true },
        }),
      { client: this.client, userId: r.createdById },
    );
  }

  async findById(organizationId: string, id: string): Promise<RecordingSessionRecord | null> {
    const row = await withOrganizationContext(
      organizationId,
      (tx) =>
        tx.recordingSession.findFirst({ where: { organizationId, id }, select: sessionSelect }),
      { client: this.client },
    );
    return row ? toSessionRecord(row) : null;
  }

  private static async lock(tx: DatabaseTransaction, organizationId: string, id: string) {
    const rows = await tx.$queryRaw<{ status: string; total_bytes: bigint }[]>`
      SELECT status::text AS status, total_bytes FROM recording_sessions
      WHERE org_id = ${organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  async reserveChunk(
    organizationId: string,
    id: string,
    chunk: RecordingChunkRecord,
    maxTotalBytes: number,
  ): Promise<ReserveChunkResult> {
    return withOrganizationContext(
      organizationId,
      async (tx) => {
        const s = await PrismaRecordingSessionRepository.lock(tx, organizationId, id);
        if (s?.status !== 'uploading') return 'not_uploading';
        const prev = await tx.recordingSessionChunk.findFirst({
          where: { organizationId, sessionId: id, seq: chunk.seq },
          select: { sizeBytes: true },
        });
        const total = Number(s.total_bytes) - (prev?.sizeBytes ?? 0) + chunk.sizeBytes;
        if (total > maxTotalBytes) return 'over_limit';
        await tx.recordingSessionChunk.upsert({
          where: { sessionId_seq: { sessionId: id, seq: chunk.seq } },
          create: {
            organizationId,
            sessionId: id,
            seq: chunk.seq,
            sizeBytes: chunk.sizeBytes,
            sha256: chunk.sha256Hex,
            storageKey: chunk.key,
          },
          update: { sizeBytes: chunk.sizeBytes, sha256: chunk.sha256Hex, uploadedAt: null },
          select: { id: true },
        });
        await tx.recordingSession.updateMany({
          where: { organizationId, id },
          data: { totalBytes: BigInt(total) },
        });
        return 'ok';
      },
      { client: this.client },
    );
  }

  async finish(
    organizationId: string,
    id: string,
    next:
      | { status: 'completed'; chunkCount: number; durationMs: number }
      | { status: 'aborted'; abortReason: AbortReason },
  ): Promise<boolean> {
    return withOrganizationContext(
      organizationId,
      async (tx) => {
        const s = await PrismaRecordingSessionRepository.lock(tx, organizationId, id);
        if (s?.status !== 'uploading') return false;
        const now = new Date();
        if (next.status === 'aborted') {
          await tx.recordingSession.updateMany({
            where: { organizationId, id },
            data: { status: 'aborted', abortReason: next.abortReason, abortedAt: now },
          });
          return true;
        }
        const row = await tx.recordingSession.findFirstOrThrow({
          where: { organizationId, id },
          select: { meetingId: true, mimeType: true, createdById: true },
        });
        // Ids up front: the source key embeds the recording id. The FileObject stays pending_upload (no bytes yet)
        // until the worker has assembled and verified the chunks.
        const recordingId = randomUUID();
        const file = await tx.fileObject.create({
          data: {
            organizationId,
            meetingId: row.meetingId,
            uploadedById: row.createdById,
            kind: 'raw',
            status: 'pending_upload',
            provider: this.provider,
            bucket: this.bucket,
            key: sessionSourceKey(organizationId, row.meetingId, recordingId, row.mimeType),
            mimeType: row.mimeType,
            sizeBytes: s.total_bytes,
          },
          select: { id: true },
        });
        const rec = await tx.recording.create({
          data: {
            id: recordingId,
            organizationId,
            meetingId: row.meetingId,
            fileObjectId: file.id,
            durationMs: next.durationMs,
            status: 'uploading',
          },
          select: { id: true },
        });
        await tx.recordingSession.updateMany({
          where: { organizationId, id },
          data: {
            status: 'completed',
            chunkCount: next.chunkCount,
            durationMs: next.durationMs,
            recordingId: rec.id,
            completedAt: now,
          },
        });
        return true;
      },
      { client: this.client },
    );
  }
}

/**
 * Reconciler discovery. organizations has no RLS (ids only); every subject query runs under
 * withOrganizationContext(org), so forced RLS still scopes it.
 */
export class PrismaStaleMediaStore implements StaleMediaStore {
  constructor(private readonly client: DatabaseClient) {}

  async organizationIds(): Promise<string[]> {
    const rows = await this.client.organization.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  async staleUploads(
    organizationId: string,
    before: Date,
    limit: number,
  ): Promise<StaleMediaSubject[]> {
    return withOrganizationContext(
      organizationId,
      (tx) =>
        tx.fileObject.findMany({
          where: {
            organizationId,
            kind: 'raw',
            status: 'processing',
            scanStatus: 'pending',
            deletedAt: null,
            updatedAt: { lt: before },
            // Upload sources only (organizations/{org}/uploads/{id}/source).
            key: { startsWith: `organizations/${organizationId}/uploads/` },
          },
          select: { id: true, meetingId: true },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        }),
      { client: this.client },
    );
  }

  async unassembledSessions(
    organizationId: string,
    before: Date,
    limit: number,
  ): Promise<StaleMediaSubject[]> {
    return withOrganizationContext(
      organizationId,
      (tx) =>
        tx.recordingSession.findMany({
          where: {
            organizationId,
            status: 'completed',
            updatedAt: { lt: before },
            // #303 M-1: deleted parents are never re-queued (the worker would skip them anyway).
            organization: { deletedAt: null },
            meeting: { deletedAt: null },
            recording: { deletedAt: null, file: { status: 'pending_upload', deletedAt: null } },
          },
          select: { id: true, meetingId: true },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        }),
      { client: this.client },
    );
  }
}
