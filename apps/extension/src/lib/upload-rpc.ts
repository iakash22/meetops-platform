/**
 * Upload API calls from the offscreen recorder, proxied to the background service worker.
 *
 * Offscreen documents can't read chrome.storage.session, where the ADR-005 tokens live, and must stay TypeBox-free.
 * So with WXT_FEATURE_HTTP_UPLOAD on, the offscreen document uses RpcUploadClient: init / chunk URL / complete /
 * abort become `UPLOAD_RPC` messages that the worker accepts only from the offscreen document, validates against the
 * contracts schemas and runs on its HttpUploadClient (bearer via auth.apiFetch). The presigned PUT itself still runs
 * in the offscreen document, through a transport that never carries a bearer. Tokens never cross the message boundary.
 */
import type {
  AbortRecordingSessionRequest,
  ChunkUploadUrlRequest,
  ChunkUploadUrlResponse,
  CompleteRecordingSessionRequest,
  CompleteRecordingSessionResponse,
  InitRecordingSessionRequest,
  InitRecordingSessionResponse,
} from '@meetops/contracts/types';
import { safeErrorMessage } from './redact.js';
import { UUID_RE, type StorageTransport, type UploadClient } from './upload.js';
import type { UploadValidators } from './upload-http.js';

export type UploadRpcRequest =
  | {
      target: 'background';
      type: 'UPLOAD_RPC';
      op: 'initSession';
      req: InitRecordingSessionRequest;
    }
  | {
      target: 'background';
      type: 'UPLOAD_RPC';
      op: 'requestChunkUrl';
      sessionId: string;
      req: ChunkUploadUrlRequest;
    }
  | {
      target: 'background';
      type: 'UPLOAD_RPC';
      op: 'complete';
      sessionId: string;
      req: CompleteRecordingSessionRequest;
    }
  | {
      target: 'background';
      type: 'UPLOAD_RPC';
      op: 'abort';
      sessionId: string;
      req: AbortRecordingSessionRequest;
    };

export type UploadRpcResponse = { ok: true; result?: unknown } | { ok: false; error: string };

/** Envelope shape only; `req` is schema-checked by handleUploadRpc. */
export function isUploadRpcRequest(msg: unknown): msg is UploadRpcRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.target !== 'background' || m.type !== 'UPLOAD_RPC') return false;
  if (typeof m.req !== 'object' || m.req === null) return false;
  if (m.op === 'initSession') return m.sessionId === undefined;
  if (m.op === 'requestChunkUrl' || m.op === 'complete' || m.op === 'abort') {
    return typeof m.sessionId === 'string' && UUID_RE.test(m.sessionId);
  }
  return false;
}

/** Background side: validate the request against contracts and run it on the real client. Errors are scrubbed. */
export async function handleUploadRpc(
  client: UploadClient,
  v: Pick<UploadValidators, 'initRequest' | 'chunkUrlRequest' | 'completeRequest' | 'abortRequest'>,
  msg: UploadRpcRequest,
): Promise<UploadRpcResponse> {
  try {
    switch (msg.op) {
      case 'initSession':
        if (!v.initRequest(msg.req)) break;
        return { ok: true, result: await client.initSession(msg.req) };
      case 'requestChunkUrl':
        if (!v.chunkUrlRequest(msg.req)) break;
        return { ok: true, result: await client.requestChunkUrl(msg.sessionId, msg.req) };
      case 'complete':
        if (!v.completeRequest(msg.req)) break;
        return { ok: true, result: await client.complete(msg.sessionId, msg.req) };
      case 'abort':
        if (!v.abortRequest(msg.req)) break;
        await client.abort(msg.sessionId, msg.req);
        return { ok: true };
    }
    return { ok: false, error: `Upload ${msg.op} request failed contract validation` };
  } catch (err) {
    return { ok: false, error: safeErrorMessage(err) };
  }
}

export type RpcSend = (msg: UploadRpcRequest) => Promise<UploadRpcResponse | undefined>;

export class UploadRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRpcError';
  }
}

/** Offscreen side: the UploadClient interface over UPLOAD_RPC messages, with a direct (bearer-free) storage PUT. */
export class RpcUploadClient implements UploadClient {
  readonly durable: boolean;
  readonly storage: StorageTransport;

  constructor(opts: { send: RpcSend; storage: StorageTransport; durable: boolean }) {
    this.send = opts.send;
    this.storage = opts.storage;
    this.durable = opts.durable;
  }

  private readonly send: RpcSend;

  private async call(msg: UploadRpcRequest): Promise<unknown> {
    const res = await this.send(msg);
    if (!res) throw new UploadRpcError(`Upload ${msg.op}: background did not respond`);
    if (!res.ok) throw new UploadRpcError(res.error);
    return res.result;
  }

  async initSession(req: InitRecordingSessionRequest): Promise<InitRecordingSessionResponse> {
    const r = (await this.call({
      target: 'background',
      type: 'UPLOAD_RPC',
      op: 'initSession',
      req,
    })) as InitRecordingSessionResponse | undefined;
    if (!r || typeof r.sessionId !== 'string' || !UUID_RE.test(r.sessionId)) {
      throw new UploadRpcError('Upload initSession: invalid response');
    }
    return r;
  }

  async requestChunkUrl(
    sessionId: string,
    req: ChunkUploadUrlRequest,
  ): Promise<ChunkUploadUrlResponse> {
    // Already schema-validated by the background's HttpUploadClient.
    return (await this.call({
      target: 'background',
      type: 'UPLOAD_RPC',
      op: 'requestChunkUrl',
      sessionId,
      req,
    })) as ChunkUploadUrlResponse;
  }

  async complete(
    sessionId: string,
    req: CompleteRecordingSessionRequest,
  ): Promise<CompleteRecordingSessionResponse> {
    return (await this.call({
      target: 'background',
      type: 'UPLOAD_RPC',
      op: 'complete',
      sessionId,
      req,
    })) as CompleteRecordingSessionResponse;
  }

  async abort(sessionId: string, req: AbortRecordingSessionRequest): Promise<void> {
    await this.call({ target: 'background', type: 'UPLOAD_RPC', op: 'abort', sessionId, req });
  }
}
