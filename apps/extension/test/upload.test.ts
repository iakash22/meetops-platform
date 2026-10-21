import { describe, expect, it, vi } from 'vitest';
import { CHUNK_UPLOAD_URL_TTL_SECONDS, MAX_CHUNK_BYTES } from '../src/lib/contracts.js';
import {
  StubUploadClient,
  UUID_RE,
  UploadUrlExpiredError,
  assertSafeUploadUrl,
  checkSignedHeaders,
  createFetchTransport,
  fetchTransport,
  hexToBase64,
  sha256Hex,
  splitForUpload,
  toIsoTimestamp,
  uploadChunk,
  type StorageTransport,
  type UploadClient,
} from '../src/lib/upload.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';

const init = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-21T00:00:00.000Z',
  source: 'tab' as const,
  meetingId: MID,
};
const ABC_SHA = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256', () => {
  it('is lowercase hex (contract Sha256Hex) and converts to base64 for the S3 header', async () => {
    const hex = await sha256Hex(new Blob(['abc']));
    expect(hex).toBe(ABC_SHA);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hexToBase64(hex)).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });
});

describe('StubUploadClient (contracts v0.2 flow)', () => {
  it('init returns a UUID sessionId and rejects non-ISO startedAt', async () => {
    const c = new StubUploadClient();
    expect((await c.initSession(init)).sessionId).toMatch(UUID_RE);
    await expect(c.initSession({ ...init, startedAt: 'yesterday' })).rejects.toThrow('ISO 8601');
  });

  it('signs Content-Length and sha256 into upload.headers with a 300 s TTL', async () => {
    const t = Date.UTC(2026, 9, 21);
    const c = new StubUploadClient({ now: () => t });
    const { sessionId } = await c.initSession(init);
    const res = await c.requestChunkUrl(sessionId, { seq: 0, sizeBytes: 3, sha256: ABC_SHA });
    expect(res.seq).toBe(0);
    expect(res.upload.method).toBe('PUT');
    expect(res.upload.url).toMatch(/^https:\/\//);
    expect(res.upload.headers).toEqual({
      'content-length': '3',
      'x-amz-checksum-sha256': hexToBase64(ABC_SHA),
    });
    expect(Date.parse(res.upload.expiresAt) - t).toBe(CHUNK_UPLOAD_URL_TTL_SECONDS * 1000);
  });

  it('validates sizeBytes and sha256 format', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    await expect(c.requestChunkUrl(sessionId, { seq: 0, sizeBytes: 0 })).rejects.toThrow();
    await expect(
      c.requestChunkUrl(sessionId, { seq: 0, sizeBytes: MAX_CHUNK_BYTES + 1 }),
    ).rejects.toThrow();
    await expect(
      c.requestChunkUrl(sessionId, { seq: 0, sizeBytes: 3, sha256: ABC_SHA.toUpperCase() }),
    ).rejects.toThrow('lowercase hex');
  });

  it('storage PUT: 403 when expired or signed headers missing/mismatched; 400 when body differs', async () => {
    let t = 1_000_000;
    const c = new StubUploadClient({ now: () => t });
    const { sessionId } = await c.initSession(init);
    const { upload } = await c.requestChunkUrl(sessionId, {
      seq: 0,
      sizeBytes: 3,
      sha256: ABC_SHA,
    });
    const body = new Blob(['abc']);
    const put = (headers: Record<string, string>, b: Blob = body) =>
      c.storage({ url: upload.url, method: 'PUT', headers, body: b });
    expect((await put({})).status).toBe(403);
    expect((await put({ ...upload.headers, 'x-amz-checksum-sha256': 'AAAA' })).status).toBe(403);
    expect((await put(upload.headers, new Blob(['abd']))).status).toBe(400);
    expect((await put(upload.headers)).status).toBe(200);
    expect(c.sessions.get(sessionId)!.chunks.get(0)).toEqual({ sizeBytes: 3, sha256: ABC_SHA });
    t += CHUNK_UPLOAD_URL_TTL_SECONDS * 1000;
    expect((await put(upload.headers)).status).toBe(403);
  });

  it('complete checks no gaps and matching digests; abort records the reason', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    await uploadChunk(c, sessionId, 0, new Blob(['abc']));
    await expect(c.complete(sessionId, { chunkCount: 2, durationMs: 1 })).rejects.toThrow(
      'Missing chunk 1',
    );
    await expect(
      c.complete(sessionId, {
        chunkCount: 1,
        chunks: [{ seq: 0, sha256: '0'.repeat(64) }],
        durationMs: 1,
      }),
    ).rejects.toThrow('Checksum');
    await expect(
      c.complete(sessionId, {
        chunkCount: 1,
        chunks: [{ seq: 0, sha256: ABC_SHA, sizeBytes: 3 }],
        durationMs: 1,
      }),
    ).resolves.toEqual({ status: 'uploaded' });
    const b = (await c.initSession(init)).sessionId;
    await c.abort(b, { reason: 'error' });
    expect(c.sessions.get(b)!.aborted).toBe('error');
    await expect(c.requestChunkUrl(b, { seq: 0, sizeBytes: 1 })).rejects.toThrow('closed');
  });
});

describe('uploadChunk helper', () => {
  it('requests the URL with seq, sizeBytes and hex sha256 and PUTs with the signed headers', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    const req = vi.spyOn(c, 'requestChunkUrl');
    const d = await uploadChunk(c, sessionId, 4, new Blob(['abc']));
    expect(d).toEqual({ seq: 4, sha256: ABC_SHA, sizeBytes: 3 });
    expect(req).toHaveBeenCalledWith(sessionId, { seq: 4, sizeBytes: 3, sha256: ABC_SHA });
    expect(c.puts).toHaveLength(1);
    expect(c.puts[0]!.headers).toEqual({
      'content-length': '3',
      'x-amz-checksum-sha256': hexToBase64(ABC_SHA),
    });
  });

  it('refreshes a URL that is already expired / about to expire before PUT', async () => {
    const t = 1_000_000;
    const c = new StubUploadClient({ now: () => t, ttlSeconds: 5 }); // 5 s < 10 s skew
    const req = vi.spyOn(c, 'requestChunkUrl');
    const { sessionId } = await c.initSession(init);
    await uploadChunk(c, sessionId, 0, new Blob(['a']), () => t);
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('maps HTTP 403 from storage to a refresh + single retry', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    const real = c.storage;
    const storage = vi.fn<StorageTransport>().mockResolvedValueOnce({ status: 403 });
    storage.mockImplementation(real);
    const client: UploadClient = Object.assign(Object.create(c) as StubUploadClient, { storage });
    const req = vi.spyOn(c, 'requestChunkUrl');
    await uploadChunk(client, sessionId, 0, new Blob(['abc']));
    expect(storage).toHaveBeenCalledTimes(2);
    expect(req).toHaveBeenCalledTimes(2);
    expect(storage.mock.calls[0]![0].url).not.toBe(storage.mock.calls[1]![0].url);
    expect(c.sessions.get(sessionId)!.chunks.size).toBe(1);
  });

  it('throws UploadUrlExpiredError after a second 403', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    const storage = vi.fn<StorageTransport>(async () => ({ status: 403 }));
    const client: UploadClient = Object.assign(Object.create(c) as StubUploadClient, { storage });
    await expect(uploadChunk(client, sessionId, 0, new Blob(['a']))).rejects.toBeInstanceOf(
      UploadUrlExpiredError,
    );
    expect(storage).toHaveBeenCalledTimes(2);
  });

  it('does not retry other HTTP errors and enforces size and seq limits', async () => {
    const storage = vi.fn<StorageTransport>(async () => ({ status: 500 }));
    const c: UploadClient = {
      durable: true,
      initSession: vi.fn(),
      requestChunkUrl: vi.fn(
        async (_s: string, r: { seq: number; sizeBytes: number; sha256?: string }) => ({
          seq: r.seq,
          upload: {
            url: 'https://x',
            method: 'PUT' as const,
            headers: {
              'content-length': String(r.sizeBytes),
              'x-amz-checksum-sha256': hexToBase64(r.sha256!),
            },
            expiresAt: '2999-01-01T00:00:00Z',
          },
        }),
      ),
      storage,
      complete: vi.fn(),
      abort: vi.fn(),
    };
    await expect(uploadChunk(c, 's', 0, new Blob(['a']))).rejects.toThrow('HTTP 500');
    expect(storage).toHaveBeenCalledTimes(1);
    const big = { size: MAX_CHUNK_BYTES + 1 } as Blob;
    await expect(uploadChunk(c, 's', 0, big)).rejects.toThrow('outside');
    await expect(uploadChunk(c, 's', 10_000, new Blob(['a']))).rejects.toThrow('out of range');
  });
});

describe('fetchTransport', () => {
  it('sends signed headers except the browser-managed Content-Length', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = new Blob(['abc']);
    const r = await fetchTransport({
      url: 'https://s3.example/x',
      method: 'PUT',
      headers: { 'Content-Length': '3', 'x-amz-checksum-sha256': 'abc=' },
      body,
    });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('https://s3.example/x', {
      method: 'PUT',
      headers: { 'x-amz-checksum-sha256': 'abc=' },
      body,
      redirect: 'error',
    });
    vi.unstubAllGlobals();
  });
});

describe('helpers', () => {
  it('splitForUpload splits at the max size and keeps small buffers whole', () => {
    const b = new Uint8Array(10).buffer;
    expect(splitForUpload(b, 10)).toEqual([b]);
    expect(splitForUpload(b, 4).map((p) => p.byteLength)).toEqual([4, 4, 2]);
  });

  it('toIsoTimestamp converts epoch ms and rejects garbage', () => {
    expect(toIsoTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(() => toIsoTimestamp('nope')).toThrow();
  });
});

describe('upload URL and signed-header safety', () => {
  it('rejects non-HTTPS upload URLs; allows http://localhost and 127.0.0.1 only in dev', () => {
    expect(() => assertSafeUploadUrl('https://s3.example/x', false)).not.toThrow();
    expect(() => assertSafeUploadUrl('http://s3.example/x', true)).toThrow(/non-HTTPS/);
    expect(() => assertSafeUploadUrl('http://localhost:9000/x', false)).toThrow(/non-HTTPS/);
    expect(() => assertSafeUploadUrl('http://localhost:9000/x', true)).not.toThrow();
    expect(() => assertSafeUploadUrl('http://127.0.0.1/x', true)).not.toThrow();
    expect(() => assertSafeUploadUrl('http://localhost.evil.com/x', true)).toThrow();
    expect(() => assertSafeUploadUrl('ftp://localhost/x', true)).toThrow();
    expect(() => assertSafeUploadUrl('not a url', true)).toThrow(/valid URL/);
  });

  it('createFetchTransport refuses http in production without calling fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const t = createFetchTransport({ allowLocalHttp: false });
    await expect(
      t({ url: 'http://localhost/x', method: 'PUT', headers: {}, body: new Blob(['a']) }),
    ).rejects.toThrow(/non-HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('checkSignedHeaders requires content-length and, with sha256, the checksum (case-insensitive)', async () => {
    const sha = await sha256Hex(new Blob(['abc']));
    const b64 = hexToBase64(sha);
    expect(() => checkSignedHeaders(undefined, 3, undefined)).toThrow(/content-length/);
    expect(() => checkSignedHeaders({ 'content-length': '4' }, 3, undefined)).toThrow(/match/);
    expect(checkSignedHeaders({ 'CONTENT-LENGTH': '3' }, 3, undefined)).toEqual({
      'CONTENT-LENGTH': '3',
    });
    expect(() => checkSignedHeaders({ 'Content-Length': '3' }, 3, sha)).toThrow(/x-amz-checksum/);
    expect(() =>
      checkSignedHeaders({ 'Content-Length': '3', 'X-Amz-Checksum-Sha256': 'AAAA' }, 3, sha),
    ).toThrow(/does not match/);
    expect(
      checkSignedHeaders({ 'content-length': '3', 'X-AMZ-CHECKSUM-SHA256': b64 }, 3, sha),
    ).toBeTruthy();
  });

  it('uploadChunk refuses a presigned URL that lacks the signed headers', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    const unsigned: UploadClient = Object.assign(Object.create(c) as StubUploadClient, {
      requestChunkUrl: async (
        sid: string,
        r: Parameters<StubUploadClient['requestChunkUrl']>[1],
      ) => {
        const res = await c.requestChunkUrl(sid, r);
        return { ...res, upload: { ...res.upload, headers: {} } };
      },
    });
    await expect(uploadChunk(unsigned, sessionId, 0, new Blob(['abc']))).rejects.toThrow(
      /content-length/,
    );
    expect(c.puts).toHaveLength(0);
  });

  it('stub init requires a UUID meetingId', async () => {
    const c = new StubUploadClient();
    await expect(c.initSession({ ...init, meetingId: 'meeting-1' })).rejects.toThrow(/meetingId/);
  });
});
