import { describe, expect, it, vi } from 'vitest';
import { uploadValidators } from '../src/lib/auth/validate.js';
import { flagEnabled, httpUploadEnabled } from '../src/lib/features.js';
import { UploadApiError } from '../src/lib/upload-http.js';
import {
  RpcUploadClient,
  UploadRpcError,
  handleUploadRpc,
  isUploadRpcRequest,
  type UploadRpcRequest,
} from '../src/lib/upload-rpc.js';
import { selectUploadClient } from '../src/lib/upload-select.js';
import { StubUploadClient, type StorageTransport, type UploadClient } from '../src/lib/upload.js';
import { CONSENT } from './helpers/consent.js';

const SID = '7d9f2c1e-3b4a-4c5d-8e6f-0a1b2c3d4e5f';
const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const initReq = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-25T08:00:00.000Z',
  source: 'tab' as const,
  consent: CONSENT,
  meetingId: MID,
};

describe('WXT_FEATURE_HTTP_UPLOAD', () => {
  it('only true / 1 turn the flag on', () => {
    for (const v of ['true', 'TRUE', ' 1 ', '1', true]) expect(flagEnabled(v)).toBe(true);
    for (const v of [undefined, '', 'false', '0', 'yes', 'on', false, 1])
      expect(flagEnabled(v)).toBe(false);
    expect(httpUploadEnabled({})).toBe(false);
    expect(httpUploadEnabled({ WXT_FEATURE_HTTP_UPLOAD: 'true' })).toBe(true);
  });

  it('is off in this build by default', () => {
    expect(httpUploadEnabled()).toBe(false);
  });

  it('selects the stub unless enabled, and only builds the HTTP client when enabled', () => {
    const make = vi.fn<() => UploadClient>(() => new StubUploadClient());
    expect(selectUploadClient(false, make)).toBeInstanceOf(StubUploadClient);
    expect(make).not.toHaveBeenCalled();
    const real = {} as UploadClient;
    make.mockReturnValueOnce(real);
    expect(selectUploadClient(true, make)).toBe(real);
  });
});

describe('UPLOAD_RPC guard', () => {
  const base = { target: 'background', type: 'UPLOAD_RPC' } as const;
  it('accepts well-formed envelopes only', () => {
    expect(isUploadRpcRequest({ ...base, op: 'initSession', req: initReq })).toBe(true);
    expect(isUploadRpcRequest({ ...base, op: 'complete', sessionId: SID, req: {} })).toBe(true);
    expect(isUploadRpcRequest({ ...base, op: 'initSession', sessionId: SID, req: initReq })).toBe(
      false,
    );
    expect(isUploadRpcRequest({ ...base, op: 'abort', sessionId: '../x', req: {} })).toBe(false);
    expect(isUploadRpcRequest({ ...base, op: 'storage', sessionId: SID, req: {} })).toBe(false);
    expect(isUploadRpcRequest({ ...base, op: 'abort', sessionId: SID })).toBe(false);
    expect(isUploadRpcRequest({ ...base, target: 'offscreen', op: 'initSession', req: {} })).toBe(
      false,
    );
    expect(isUploadRpcRequest(null)).toBe(false);
  });
});

describe('handleUploadRpc (background) and RpcUploadClient (offscreen)', () => {
  const storage: StorageTransport = async () => ({ status: 200 });

  /** Offscreen client wired straight to the background handler, as chrome.runtime.sendMessage would. */
  function pair(real: UploadClient) {
    const sent: UploadRpcRequest[] = [];
    const rpc = new RpcUploadClient({
      durable: true,
      storage,
      send: async (msg) => {
        sent.push(msg);
        return handleUploadRpc(real, uploadValidators, structuredClone(msg));
      },
    });
    return { rpc, sent };
  }

  it('proxies every op and returns results', async () => {
    const real = new StubUploadClient({ newId: () => SID });
    const { rpc, sent } = pair(real);
    expect(rpc.durable).toBe(true);
    expect(rpc.storage).toBe(storage);
    expect(await rpc.initSession(initReq)).toEqual({ sessionId: SID });
    const url = await rpc.requestChunkUrl(SID, { seq: 0, sizeBytes: 1, sha256: 'a'.repeat(64) });
    expect(url.seq).toBe(0);
    await rpc.abort(SID, { reason: 'user_stopped' });
    expect(sent.map((m) => m.op)).toEqual(['initSession', 'requestChunkUrl', 'abort']);
    expect(JSON.stringify(sent)).not.toMatch(/token|bearer/i);
  });

  it('rejects requests failing contract validation without calling the client', async () => {
    const real = new StubUploadClient();
    const spy = vi.spyOn(real, 'complete');
    const r = await handleUploadRpc(real, uploadValidators, {
      target: 'background',
      type: 'UPLOAD_RPC',
      op: 'complete',
      sessionId: SID,
      req: { chunkCount: 1, durationMs: 1, extra: true } as never,
    });
    expect(r).toEqual({ ok: false, error: 'Upload complete request failed contract validation' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces scrubbed errors and a missing background as UploadRpcError', async () => {
    const real = new StubUploadClient();
    vi.spyOn(real, 'complete').mockRejectedValue(new Error(`boom Bearer ${'T'.repeat(43)}`));
    const { rpc } = pair(real);
    const err = await rpc.complete(SID, { chunkCount: 1, durationMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadRpcError);
    expect((err as Error).message).not.toContain('T'.repeat(43));

    vi.spyOn(real, 'abort').mockRejectedValue(new UploadApiError('abort', 500, 'INTERNAL'));
    await expect(rpc.abort(SID, { reason: 'error' })).rejects.toThrow('HTTP 500 INTERNAL');

    const silent = new RpcUploadClient({ durable: true, storage, send: async () => undefined });
    await expect(silent.initSession(initReq)).rejects.toThrow('did not respond');
  });

  it('rejects a malformed init result', async () => {
    const rpc = new RpcUploadClient({
      durable: true,
      storage,
      send: async () => ({ ok: true, result: { sessionId: 'x' } }),
    });
    await expect(rpc.initSession(initReq)).rejects.toBeInstanceOf(UploadRpcError);
  });
});
