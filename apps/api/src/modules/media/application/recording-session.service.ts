import { randomUUID } from 'node:crypto';
import {
  CHUNK_UPLOAD_URL_TTL_SECONDS,
  MAX_RECORDING_SESSION_BYTES,
  type AbortReason,
  type ChunkUploadUrlRequest,
  type CompleteRecordingSessionRequest,
  type InitRecordingSessionRequest,
} from '@meetops/contracts';
import type { DirectoryCaller } from '../../directory/access.js';
import { MeetingNotFoundError } from '../../meetings/domain/meeting.js';
import { DomainError } from '../../../shared/domain-error.js';
import { checkConsentInput, checkStoredConsent } from '../domain/consent.js';
import { UploadStateConflictError, type SignedRequest } from '../domain/ports.js';
import {
  RecordingSessionNotFoundError,
  type RecordingSessionRecord,
  type RecordingSessionRepository,
} from '../domain/recording-session.js';
import type { MediaDeps } from './upload.service.js';
import { authorizeMedia } from './media-access.js';

export type InitRecordingSessionInput = Omit<InitRecordingSessionRequest, 'consent'> & {
  consent?: unknown;
};

export interface RecordingDeps extends MediaDeps {
  sessions: RecordingSessionRepository;
}

/**
 * Running-total (1.4 GB) refusal, sent as 409 CONFLICT for now.
 * TODO(#168): 413 PAYLOAD_TOO_LARGE is being proposed in contracts PR #168; switch status/code once it lands.
 */
export class RecordingLimitError extends DomainError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class ChunkSetInvalidError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, 400);
  }
}

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const hexToB64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/**
 * Chunked tab recordings. Init is org-scoped; chunks/complete/abort carry only the session id, so the org is the
 * caller's active organization and a session of any other org is 404.
 */
export class RecordingSessionService {
  constructor(private readonly d: RecordingDeps) {}

  async init(c: DirectoryCaller, body: InitRecordingSessionInput): Promise<RecordingSessionRecord> {
    authorizeMedia(c, 'create', 'RecordingSession');
    const now = this.d.now();
    const consent = checkConsentInput(body.consent, now);
    const org = c.ctx.organizationId;
    const m = isUuid(body.meetingId) ? await this.d.meetings.findById(org, body.meetingId) : null;
    if (!m) throw new MeetingNotFoundError();
    const s: RecordingSessionRecord = {
      id: randomUUID(),
      organizationId: org,
      meetingId: body.meetingId,
      createdById: c.ctx.userId,
      mimeType: body.mimeType,
      source: body.source,
      startedAt: new Date(body.startedAt),
      status: 'uploading',
      totalBytes: 0,
      chunks: new Map(),
      chunkCount: null,
      durationMs: null,
      abortReason: null,
      createdAt: now,
    };
    await this.d.sessions.create(s);
    await this.d.consents.record({
      organizationId: org,
      subjectType: 'recording_session',
      subjectId: s.id,
      consentVersion: consent.consentVersion,
      method: consent.method,
      attestedByUserId: c.ctx.userId,
      attestedAt: new Date(consent.attestedAt),
      recordedAt: now,
    });
    return s;
  }

  private async own(c: DirectoryCaller, id: string) {
    const s = isUuid(id) ? await this.d.sessions.findById(c.ctx.organizationId, id) : null;
    if (!s || s.organizationId !== c.ctx.organizationId) throw new RecordingSessionNotFoundError();
    authorizeMedia(c, 'update', 'RecordingSession', s.createdById);
    return s;
  }

  private static assertUploading(s: RecordingSessionRecord) {
    if (s.status !== 'uploading') {
      throw new UploadStateConflictError(`Recording session is ${s.status}`);
    }
  }

  async chunkUrl(
    c: DirectoryCaller,
    id: string,
    body: ChunkUploadUrlRequest,
  ): Promise<SignedRequest> {
    const s = await this.own(c, id);
    RecordingSessionService.assertUploading(s);
    const key = `organizations/${s.organizationId}/recording-sessions/${s.id}/chunks/${String(body.seq).padStart(5, '0')}`;
    const res = await this.d.sessions.reserveChunk(
      s.organizationId,
      s.id,
      { seq: body.seq, sizeBytes: body.sizeBytes, sha256Hex: body.sha256, key },
      MAX_RECORDING_SESSION_BYTES,
    );
    if (res === 'not_uploading')
      throw new UploadStateConflictError('Recording session is not uploading');
    if (res === 'over_limit') {
      throw new RecordingLimitError(`Recording would exceed ${MAX_RECORDING_SESSION_BYTES} bytes`);
    }
    return this.d.signer.presignPut({
      key,
      mimeType: s.mimeType,
      sizeBytes: body.sizeBytes,
      checksumSha256Base64: hexToB64(body.sha256),
      ttlSeconds: CHUNK_UPLOAD_URL_TTL_SECONDS,
    });
  }

  /** Queues processing only with every chunk 0..n-1 stored, the byte cap held and a valid stored consent. */
  async complete(
    c: DirectoryCaller,
    id: string,
    body: CompleteRecordingSessionRequest,
  ): Promise<RecordingSessionRecord> {
    const s = await this.own(c, id);
    if (s.status === 'completed') {
      // #302 M-1: finish() committed but the enqueue may have failed. A replay re-enqueues with the same
      // deterministic job id (a no-op while that job exists); the stored chunk set is final, the body is ignored.
      const consent = checkStoredConsent(
        await this.d.consents.findLatest(s.organizationId, 'recording_session', s.id),
      );
      await this.enqueue(s, consent.id);
      return s;
    }
    RecordingSessionService.assertUploading(s);
    const consent = checkStoredConsent(
      await this.d.consents.findLatest(s.organizationId, 'recording_session', s.id),
    );
    if (s.chunks.size !== body.chunkCount) {
      throw new ChunkSetInvalidError(
        `Expected ${s.chunks.size} chunks, got chunkCount ${body.chunkCount}`,
      );
    }
    for (let seq = 0; seq < body.chunkCount; seq++) {
      if (!s.chunks.has(seq)) throw new ChunkSetInvalidError(`Chunk ${seq} is missing`);
    }
    if (body.chunks) {
      const seen = new Set<number>();
      for (const ch of body.chunks) {
        const known = s.chunks.get(ch.seq);
        if (seen.has(ch.seq)) throw new ChunkSetInvalidError(`Chunk ${ch.seq} listed twice`);
        seen.add(ch.seq);
        if (
          !known ||
          known.sha256Hex !== ch.sha256 ||
          (ch.sizeBytes !== undefined && ch.sizeBytes !== known.sizeBytes)
        ) {
          throw new ChunkSetInvalidError(`Chunk ${ch.seq} does not match the signed chunk`);
        }
      }
    }
    if (s.totalBytes > MAX_RECORDING_SESSION_BYTES) {
      throw new RecordingLimitError(`Recording exceeds ${MAX_RECORDING_SESSION_BYTES} bytes`);
    }
    for (const ch of s.chunks.values()) {
      const stored = await this.d.signer.head(ch.key);
      if (!stored || stored.sizeBytes !== ch.sizeBytes) {
        throw new UploadStateConflictError(`Chunk ${ch.seq} has not been uploaded`);
      }
      // Security review B 4.2: the stored full-object SHA-256 must equal the one signed into the chunk PUT; a
      // missing or multipart (`-N`) checksum fails closed, as for direct uploads.
      if (stored.checksumSha256Base64 !== hexToB64(ch.sha256Hex)) {
        throw new UploadStateConflictError(`Chunk ${ch.seq} checksum does not match`);
      }
    }
    const ok = await this.d.sessions.finish(s.organizationId, s.id, {
      status: 'completed',
      chunkCount: body.chunkCount,
      durationMs: body.durationMs,
    });
    if (!ok) throw new UploadStateConflictError('Recording session is not uploading');
    await this.enqueue(s, consent.id);
    return { ...s, status: 'completed', chunkCount: body.chunkCount, durationMs: body.durationMs };
  }

  private async enqueue(s: RecordingSessionRecord, consentAttestationId: string): Promise<void> {
    await this.d.jobs.enqueue({
      kind: 'process_recording_session',
      organizationId: s.organizationId,
      subjectType: 'recording_session',
      subjectId: s.id,
      consentAttestationId,
      meetingId: s.meetingId,
    });
  }

  async abort(c: DirectoryCaller, id: string, reason: AbortReason): Promise<void> {
    const s = await this.own(c, id);
    RecordingSessionService.assertUploading(s);
    if (!(await this.d.sessions.finish(s.organizationId, s.id, { status: 'aborted', abortReason: reason }))) {
      throw new UploadStateConflictError('Recording session is not uploading');
    }
  }
}
