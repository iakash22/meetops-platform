import { randomUUID } from 'node:crypto';
import type { AbortReason, ConsentSubjectType, FileObjectScanStatus } from '@meetops/contracts';
import type {
  RecordingChunkRecord,
  RecordingSessionRecord,
  RecordingSessionRepository,
} from '../domain/recording-session.js';
import type { ConsentRecord, ConsentRepository } from '../domain/consent.js';
import type {
  MeetingConsentEventRecord,
  MeetingConsentRepository,
  NewMeetingConsentEvent,
} from '../domain/meeting-consent.js';
import type {
  FileObjectRecord,
  FileObjectRepository,
  FileObjectStatus,
  MediaJobQueue,
  MediaProcessingJob,
  MediaSigner,
  SignedRequest,
  StoredObjectHead,
} from '../domain/ports.js';
import { downloadContentType } from '../domain/ports.js';
import { assertTtl } from '@meetops/storage';

export class InMemoryConsentRepository implements ConsentRepository {
  readonly rows: ConsentRecord[] = [];
  async record(r: Omit<ConsentRecord, 'id'>): Promise<ConsentRecord> {
    const row = { ...r, id: randomUUID() };
    this.rows.push(row);
    return row;
  }
  async findLatest(organizationId: string, subjectType: ConsentSubjectType, subjectId: string) {
    const hits = this.rows.filter(
      (r) =>
        r.organizationId === organizationId &&
        r.subjectType === subjectType &&
        r.subjectId === subjectId,
    );
    return hits.at(-1) ?? null;
  }
}

export class InMemoryFileObjectRepository implements FileObjectRepository {
  readonly rows = new Map<string, FileObjectRecord>();
  async create(r: FileObjectRecord) {
    this.rows.set(r.id, { ...r });
    return r;
  }
  async findById(organizationId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.organizationId === organizationId ? { ...r } : null;
  }
  async setStatus(
    organizationId: string,
    id: string,
    status: FileObjectStatus,
    scanStatus?: FileObjectScanStatus,
  ) {
    const r = this.rows.get(id);
    if (!r || r.organizationId !== organizationId) return;
    r.status = status;
    if (scanStatus) r.scanStatus = scanStatus;
  }
}

/** Dev/test signer: fake https URLs, plus `put()` so tests can simulate the client upload. */
export class FakeMediaSigner implements MediaSigner {
  readonly stored = new Map<string, StoredObjectHead>();
  /** Checksum signed into each presigned PUT: what S3 stores when the client sends the signed headers. */
  private readonly signedChecksums = new Map<string, string>();
  constructor(private readonly now: () => Date = () => new Date()) {}
  private sign(
    method: 'PUT' | 'GET',
    key: string,
    ttlSeconds: number,
    headers: Record<string, string>,
  ): SignedRequest {
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    const url = `https://storage.example.test/${key}?X-Amz-Expires=${ttlSeconds}&X-Amz-Signature=fake`;
    return { url, method, headers, expiresAt };
  }
  async presignPut(s: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    ttlSeconds: number;
  }) {
    // Same cap as the real S3UploadSourceSigner, so a TTL above it fails here too (#300 M-1).
    assertTtl(s.ttlSeconds);
    this.signedChecksums.set(s.key, s.checksumSha256Base64);
    return this.sign('PUT', s.key, s.ttlSeconds, {
      'content-length': String(s.sizeBytes),
      'content-type': s.mimeType,
      'x-amz-checksum-sha256': s.checksumSha256Base64,
    });
  }
  async presignGet(s: { key: string; ttlSeconds: number; contentType: string }) {
    const r = this.sign('GET', s.key, s.ttlSeconds, {});
    const q = new URLSearchParams({
      'response-content-disposition': 'attachment',
      'response-content-type': downloadContentType(s.contentType),
    });
    return { ...r, url: `${r.url}&${q.toString()}` };
  }
  async head(key: string) {
    const h = this.stored.get(key);
    return h ? { ...h } : null;
  }
  /** Simulates the client PUT. `checksum` defaults to the one signed into the presigned PUT. */
  put(key: string, sizeBytes: number, checksum?: string | null) {
    const checksumSha256Base64 =
      checksum === undefined ? (this.signedChecksums.get(key) ?? null) : checksum;
    this.stored.set(key, { sizeBytes, checksumSha256Base64 });
  }
}

/** Mirrors BullMQ's deterministic-id dedupe: one job per (kind, org, subject). */
export class InMemoryMediaJobQueue implements MediaJobQueue {
  readonly jobs: MediaProcessingJob[] = [];
  /** Ids treated as finished (tests): requeue replaces them. */
  readonly finished = new Set<string>();
  private static id(j: MediaProcessingJob) {
    return `${j.kind}_${j.organizationId}_${j.subjectId}`;
  }
  async enqueue(job: MediaProcessingJob) {
    if (this.jobs.some((j) => InMemoryMediaJobQueue.id(j) === InMemoryMediaJobQueue.id(job)))
      return;
    this.jobs.push(job);
  }
  async requeue(job: MediaProcessingJob) {
    const id = InMemoryMediaJobQueue.id(job);
    if (this.finished.delete(id)) {
      const i = this.jobs.findIndex((j) => InMemoryMediaJobQueue.id(j) === id);
      if (i >= 0) this.jobs.splice(i, 1);
    }
    if (this.jobs.some((j) => InMemoryMediaJobQueue.id(j) === id)) return false;
    this.jobs.push(job);
    return true;
  }
}

export class InMemoryRecordingSessionRepository implements RecordingSessionRepository {
  readonly rows = new Map<string, RecordingSessionRecord>();
  async create(r: RecordingSessionRecord) {
    this.rows.set(r.id, { ...r, chunks: new Map(r.chunks) });
  }
  async findById(organizationId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.organizationId === organizationId ? { ...r, chunks: new Map(r.chunks) } : null;
  }
  async reserveChunk(
    organizationId: string,
    id: string,
    chunk: RecordingChunkRecord,
    maxTotalBytes: number,
  ) {
    const r = this.rows.get(id);
    if (!r || r.organizationId !== organizationId || r.status !== 'uploading')
      return 'not_uploading' as const;
    const total = r.totalBytes - (r.chunks.get(chunk.seq)?.sizeBytes ?? 0) + chunk.sizeBytes;
    if (total > maxTotalBytes) return 'over_limit' as const;
    r.chunks.set(chunk.seq, { ...chunk });
    r.totalBytes = total;
    return 'ok' as const;
  }
  async finish(
    organizationId: string,
    id: string,
    next:
      | { status: 'completed'; chunkCount: number; durationMs: number }
      | { status: 'aborted'; abortReason: AbortReason },
  ) {
    const r = this.rows.get(id);
    if (!r || r.organizationId !== organizationId || r.status !== 'uploading') return false;
    Object.assign(r, next, next.status === 'completed' ? { sourcePending: true } : {});
    return true;
  }
}

export class InMemoryMeetingConsentRepository implements MeetingConsentRepository {
  readonly rows: MeetingConsentEventRecord[] = [];
  async append(e: NewMeetingConsentEvent): Promise<MeetingConsentEventRecord> {
    const row = { ...e, id: randomUUID() };
    this.rows.push(row);
    return { ...row };
  }
  async list(organizationId: string, meetingId: string, limit: number) {
    return (
      this.rows
        .filter((r) => r.organizationId === organizationId && r.meetingId === meetingId)
        // Same order as Prisma: insertion order (the DB sequence), newest first; recordedAt is not consulted.
        .reverse()
        .slice(0, limit)
        .map((r) => ({ ...r }))
    );
  }
}
