import { describe, expect, it, vi } from 'vitest';
import { CHUNK_UPLOAD_URL_TTL_SECONDS, MAX_CHUNK_BYTES } from '../src/lib/contracts.js';
import {
  StubUploadClient,
  UUID_RE,
  UploadUrlExpiredError,
  splitForUpload,
  toIsoTimestamp,
  uploadChunk,
  type UploadClient,
} from '../src/lib/upload.js';

const init = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-21T00:00:00.000Z',
  source: 'tab' as const,
};

describe('StubUploadClient (contracts v0.2 flow)', () => {
  it('init returns a UUID sessionId and rejects non-ISO startedAt', async () => {
    const c = new StubUploadClient();
    expect((await c.initSession(init)).sessionId).toMatch(UUID_RE);
    await expect(c.initSession({ ...init, startedAt: 'yesterday' })).rejects.toThrow('ISO 8601');
  });

  it('issues presigned PUT URLs with a 300 s TTL and accepts PUTs before expiry', async () => {
    let t = Date.UTC(2026, 9, 21);
    const c = new StubUploadClient({ now: () => t });
    const { sessionId } = await c.initSession(init);
    const res = await c.requestChunkUrl(sessionId, { seq: 0 });
    expect(res.seq).toBe(0);
    expect(res.upload.method).toBe('PUT');
    expect(res.upload.url).toMatch(/^https:\/\//);
    expect(Date.parse(res.upload.expiresAt) - t).toBe(CHUNK_UPLOAD_URL_TTL_SECONDS * 1000);
    await c.putChunk(res.upload, new Blob(['abc']));
    expect(c.sessions.get(sessionId)!.chunks.get(0)).toBe(3);
    t += CHUNK_UPLOAD_URL_TTL_SECONDS * 1000;
    await expect(c.putChunk(res.upload, new Blob(['x']))).rejects.toBeInstanceOf(
      UploadUrlExpiredError,
    );
  });

  it('complete requires chunkCount >= 1 and returns RecordingStatus; abort records the reason', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    await expect(c.complete(sessionId, { chunkCount: 0, durationMs: 0 })).rejects.toThrow();
    await expect(c.complete(sessionId, { chunkCount: 2, durationMs: 10 })).resolves.toEqual({
      status: 'uploaded',
    });
    const b = (await c.initSession(init)).sessionId;
    await c.abort(b, { reason: 'error' });
    expect(c.sessions.get(b)!.aborted).toBe('error');
    await expect(c.requestChunkUrl(b, { seq: 0 })).rejects.toThrow('closed');
  });
});

describe('uploadChunk helper', () => {
  it('refreshes a URL that is already expired / about to expire before PUT', async () => {
    const t = 1_000_000;
    const c = new StubUploadClient({ now: () => t, ttlSeconds: 5 }); // 5 s < 10 s skew
    const req = vi.spyOn(c, 'requestChunkUrl');
    const { sessionId } = await c.initSession(init);
    await uploadChunk(c, sessionId, 0, new Blob(['a']), () => t);
    expect(req).toHaveBeenCalledTimes(2);
  });

  it('re-requests the URL and retries once when the PUT reports expiry', async () => {
    const c = new StubUploadClient();
    const { sessionId } = await c.initSession(init);
    const put = vi
      .spyOn(c, 'putChunk')
      .mockRejectedValueOnce(new UploadUrlExpiredError())
      .mockResolvedValueOnce(undefined);
    const req = vi.spyOn(c, 'requestChunkUrl');
    await uploadChunk(c, sessionId, 3, new Blob(['a']));
    expect(put).toHaveBeenCalledTimes(2);
    expect(req).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]![0].url).not.toBe(put.mock.calls[1]![0].url);
  });

  it('does not retry other errors and enforces size and seq limits', async () => {
    const put = vi.fn(async () => Promise.reject(new Error('500')));
    const c: UploadClient = {
      durable: true,
      initSession: vi.fn(),
      requestChunkUrl: vi.fn(async (_s: string, r: { seq: number }) => ({
        seq: r.seq,
        upload: { url: 'https://x', method: 'PUT' as const, expiresAt: '2999-01-01T00:00:00Z' },
      })),
      putChunk: put,
      complete: vi.fn(),
      abort: vi.fn(),
    };
    await expect(uploadChunk(c, 's', 0, new Blob(['a']))).rejects.toThrow('500');
    expect(put).toHaveBeenCalledTimes(1);
    const big = { size: MAX_CHUNK_BYTES + 1 } as Blob;
    await expect(uploadChunk(c, 's', 0, big)).rejects.toThrow('exceeds');
    await expect(uploadChunk(c, 's', 100_000, new Blob(['a']))).rejects.toThrow('out of range');
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
