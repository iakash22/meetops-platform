import type {
  AbortReason,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionResponse,
  ConsentMethod,
  Id,
  InitRecordingSessionRequest,
  InitRecordingSessionResponse,
} from '@meetops/contracts';
import { CURRENT_CONSENT_VERSION, MAX_CHUNK_BYTES, MAX_CHUNKS } from '@meetops/contracts/types';
import type { ApiClient } from '@/lib/api/client';
import { sha256Base64 } from '@/features/meetings/upload-button';

/** Recording-session routes served by the API media module (#197); mirrors its RECORDING_SESSION_PATHS. */
export const RECORDING_PATHS = {
  init: (organizationId: Id) => `/orgs/${encodeURIComponent(organizationId)}/recording-sessions`,
  chunk: (sessionId: Id) => `/recording-sessions/${encodeURIComponent(sessionId)}/chunks`,
  complete: (sessionId: Id) => `/recording-sessions/${encodeURIComponent(sessionId)}/complete`,
  abort: (sessionId: Id) => `/recording-sessions/${encodeURIComponent(sessionId)}/abort`,
} as const;

/** MediaRecorder timeslice: one chunk per 10 s keeps chunks far below MAX_CHUNK_BYTES. */
export const CHUNK_MS = 10_000;

/** Lowercase hex sha256 (ChunkUploadUrlRequest.sha256). Reuses the upload hasher, which handles jsdom/realm quirks. */
export async function sha256Hex(data: Blob): Promise<string> {
  const bin = atob(await sha256Base64(data));
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

export function hexToBase64(hex: string): string {
  let bin = '';
  for (let i = 0; i < hex.length; i += 2)
    bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

export type SessionState =
  | { phase: 'idle' }
  | { phase: 'recording'; sessionId: Id; uploaded: number; pending: number }
  | { phase: 'finishing'; sessionId: Id }
  | { phase: 'done'; status: CompleteRecordingSessionResponse['status'] }
  | { phase: 'aborted'; reason: AbortReason }
  | { phase: 'error'; error: unknown };

/**
 * Drives one recording session: init (with consent) → per-chunk signed PUT, uploaded in order → complete, or abort.
 * Framework-free so it is unit-testable; the React panel subscribes via `onChange`.
 */
export class RecordingSessionUploader {
  private sessionId: Id | null = null;
  private seq = 0;
  private uploaded = 0;
  private queue: Promise<void> = Promise.resolve();
  private failed: unknown = null;
  private startedMs = 0;

  constructor(
    private readonly api: ApiClient,
    private readonly organizationId: Id,
    private readonly onChange: (s: SessionState) => void,
    private readonly doFetch: typeof fetch = (...a) => fetch(...a),
  ) {}

  async start(opts: { meetingId: Id; mimeType: string; consent: ConsentMethod }): Promise<Id> {
    const now = new Date();
    this.startedMs = now.getTime();
    const { sessionId } = await this.api.request<InitRecordingSessionResponse>(
      'POST',
      RECORDING_PATHS.init(this.organizationId),
      {
        mimeType: opts.mimeType,
        startedAt: now.toISOString(),
        source: 'tab',
        meetingId: opts.meetingId,
        consent: {
          consentVersion: CURRENT_CONSENT_VERSION,
          attestedAt: now.toISOString(),
          method: opts.consent,
        },
      } satisfies InitRecordingSessionRequest,
    );
    this.sessionId = sessionId;
    this.emit();
    return sessionId;
  }

  /** Queue a MediaRecorder chunk; uploads run one at a time, in seq order. */
  push(chunk: Blob): void {
    if (!this.sessionId || chunk.size === 0 || this.failed) return;
    if (this.seq >= MAX_CHUNKS || chunk.size > MAX_CHUNK_BYTES) {
      this.fail(new Error('Recording is too large to upload.'));
      return;
    }
    const sessionId = this.sessionId;
    const seq = this.seq++;
    this.emit();
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      try {
        const sha256 = await sha256Hex(chunk);
        const { upload } = await this.api.request<ChunkUploadUrlResponse>(
          'POST',
          RECORDING_PATHS.chunk(sessionId),
          { seq, sizeBytes: chunk.size, sha256 },
        );
        if (!upload.url.startsWith('https://')) throw new Error('Insecure upload URL');
        // content-length is set by the browser; it is a forbidden request header.
        const headers = Object.fromEntries(
          Object.entries(upload.headers).filter(([k]) => k.toLowerCase() !== 'content-length'),
        );
        const res = await this.doFetch(upload.url, {
          method: 'PUT',
          headers,
          body: chunk,
          credentials: 'omit',
        });
        if (!res.ok) throw new Error(`Chunk ${seq} upload failed (${res.status})`);
        this.uploaded++;
        this.emit();
      } catch (err) {
        this.fail(err);
      }
    });
  }

  /** Wait for queued chunks, then complete. */
  async finish(): Promise<void> {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.onChange({ phase: 'finishing', sessionId });
    await this.queue;
    if (this.failed) return;
    if (this.seq === 0) {
      await this.abort('error');
      return;
    }
    try {
      const res = await this.api.request<CompleteRecordingSessionResponse>(
        'POST',
        RECORDING_PATHS.complete(sessionId),
        { chunkCount: this.seq, durationMs: Math.max(0, Date.now() - this.startedMs) },
      );
      this.onChange({ phase: 'done', status: res.status });
    } catch (err) {
      this.fail(err);
    }
  }

  async abort(reason: AbortReason): Promise<void> {
    const sessionId = this.sessionId;
    this.failed ??= 'aborted';
    if (sessionId) {
      try {
        await this.api.request('POST', RECORDING_PATHS.abort(sessionId), { reason });
      } catch {
        // best effort: the server also expires abandoned sessions.
      }
    }
    this.onChange({ phase: 'aborted', reason });
  }

  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = error;
    this.onChange({ phase: 'error', error });
    if (this.sessionId)
      void this.api
        .request('POST', RECORDING_PATHS.abort(this.sessionId), { reason: 'error' })
        .catch(() => undefined);
  }

  private emit() {
    if (!this.sessionId || this.failed) return;
    this.onChange({
      phase: 'recording',
      sessionId: this.sessionId,
      uploaded: this.uploaded,
      pending: this.seq - this.uploaded,
    });
  }
}
