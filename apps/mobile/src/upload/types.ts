import type {
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  CompleteRecordingSessionResponse,
  ConsentAttestationInput,
  InitRecordingSessionRequest,
  InitRecordingSessionResponse,
  AbortReason,
} from '@meetops/contracts';

/**
 * CONTRACTS DEPENDENCY: `RecordingSource` is only `'tab'` today. Mobile sends `'mobile'`, which needs a contracts bump
 * (Architecture) before the API will accept it.
 */
export type MobileInitRecordingSessionRequest = Omit<InitRecordingSessionRequest, 'source'> & {
  source: 'mobile';
};

/** One locally stored chunk, already hashed at write time. */
export interface LocalChunk {
  seq: number;
  sizeBytes: number;
  /** Lowercase hex sha256 of the chunk body. */
  sha256: string;
}

export type QueueItemState = 'pending' | 'uploading' | 'failed' | 'done';

export interface QueueItem {
  /** Local recording id (also the on-device folder name). */
  id: string;
  organizationId: string;
  meetingId: string;
  mimeType: InitRecordingSessionRequest['mimeType'];
  startedAt: string;
  durationMs: number;
  chunks: LocalChunk[];
  /** From the participant notice (R3, contracts G11). Required: no attestation, no upload. */
  consent: ConsentAttestationInput;
  state: QueueItemState;
  sessionId: string | null;
  uploadedSeqs: number[];
  attempts: number;
  /** Epoch ms of the next retry. */
  nextAttemptAt: number;
  /** Epoch ms the recording was queued (retention clock, R4). */
  queuedAt: number;
  /** Last error, user-safe text only. */
  lastError: string | null;
}

/** Durable queue metadata (no audio). Native impl: encrypted file in the app sandbox, excluded from backups. */
export interface QueueStore {
  load(): Promise<QueueItem[]>;
  save(items: QueueItem[]): Promise<void>;
}

/** Encrypted on-device chunk files (R5). Native impl lands with the M4 recorder. */
export interface ChunkSource {
  read(recordingId: string, seq: number): Promise<Uint8Array>;
  /** Deletes every chunk of the recording. */
  remove(recordingId: string): Promise<void>;
  /** R6: true when no file of the recording is left. */
  exists(recordingId: string): Promise<boolean>;
}

/** The recording-session routes (contracts `recording-sessions.ts`). */
export interface RecordingUploadApi {
  init(
    organizationId: string,
    body: MobileInitRecordingSessionRequest,
  ): Promise<InitRecordingSessionResponse>;
  chunkUrl(sessionId: string, body: ChunkUploadUrlRequest): Promise<ChunkUploadUrlResponse>;
  /** PUT the bytes to the presigned URL with the signed headers verbatim. */
  put(upload: ChunkUploadUrlResponse['upload'], body: Uint8Array): Promise<void>;
  complete(
    sessionId: string,
    body: CompleteRecordingSessionRequest,
  ): Promise<CompleteRecordingSessionResponse>;
  abort(sessionId: string, reason: AbortReason): Promise<void>;
}

export interface NetworkStatus {
  isOnline(): boolean;
}
