import { ApiError } from '../src/api/client';
import { createHttpRecordingUploadApi } from '../src/upload/httpRecordingUploadApi';
import type { ChunkSource, QueueItem, RecordingUploadApi } from '../src/upload/types';
import {
  RETENTION_MS,
  RETENTION_WARNING_MS,
  createUploadQueueEngine,
  type NewRecording,
} from '../src/upload/uploadQueueEngine';

const consent = {
  consentVersion: '2026-11',
  attestedAt: '2026-10-26T10:00:00.000Z',
  method: 'all_parties_notified',
} as const;

const recording = (id = 'r1'): NewRecording => ({
  id,
  organizationId: 'org-1',
  meetingId: 'm-1',
  mimeType: 'audio/webm',
  startedAt: '2026-10-26T10:00:00.000Z',
  durationMs: 60_000,
  chunks: [
    { seq: 0, sizeBytes: 3, sha256: 'a'.repeat(64) },
    { seq: 1, sizeBytes: 3, sha256: 'b'.repeat(64) },
  ],
  consent,
});

function setup(opts: { failChunkOnce?: boolean; leftover?: boolean } = {}) {
  let t = 1_000_000;
  let online = true;
  let saved: QueueItem[] = [];
  const files = new Set<string>(['r1', 'r2']);
  const calls: string[] = [];
  let failed = false;
  const api: RecordingUploadApi = {
    init: jest.fn(async (_o, body) => {
      calls.push(`init:${body.consent.method}`);
      return { sessionId: 's1' };
    }),
    chunkUrl: jest.fn(async (_s, body) => {
      calls.push(`url:${body.seq}`);
      if (opts.failChunkOnce && body.seq === 1 && !failed) {
        failed = true;
        throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'down');
      }
      return {
        seq: body.seq,
        upload: {
          url: 'https://s3/x',
          method: 'PUT' as const,
          headers: { 'content-length': '3' },
          expiresAt: '',
        },
        expiresAt: '',
      };
    }),
    put: jest.fn(async () => {
      calls.push('put');
    }),
    complete: jest.fn(async () => {
      calls.push('complete');
      return { status: 'processing' as const };
    }),
    abort: jest.fn(async (_s, reason) => {
      calls.push(`abort:${reason}`);
    }),
  };
  const chunks: ChunkSource = {
    read: async () => new Uint8Array([1, 2, 3]),
    remove: jest.fn(async (id) => {
      if (!opts.leftover) files.delete(id);
    }),
    exists: async (id) => files.has(id),
  };
  const engine = createUploadQueueEngine({
    store: { load: async () => saved, save: async (i) => void (saved = i) },
    chunks,
    api,
    network: { isOnline: () => online },
    now: () => t,
  });
  return {
    engine,
    api,
    calls,
    files,
    setOnline: (v: boolean) => (online = v),
    advance: (ms: number) => (t += ms),
    saved: () => saved,
  };
}

describe('upload queue engine (M5)', () => {
  it('uploads with consent, completes, then deletes the local copy (verified)', async () => {
    const s = setup();
    await s.engine.enqueue(recording());
    expect(await s.engine.status()).toMatchObject({ pending: 1, offline: false });
    await s.engine.process();
    expect(s.calls).toEqual([
      'init:all_parties_notified',
      'url:0',
      'put',
      'url:1',
      'put',
      'complete',
    ]);
    expect(s.files.has('r1')).toBe(false);
    expect(await s.engine.status()).toMatchObject({ pending: 0 });
  });

  it('pauses offline and resumes later', async () => {
    const s = setup();
    s.setOnline(false);
    await s.engine.enqueue(recording());
    await s.engine.process();
    expect(s.calls).toEqual([]);
    expect(await s.engine.status()).toMatchObject({ pending: 1, offline: true });
    s.setOnline(true);
    await s.engine.process();
    expect(s.calls).toContain('complete');
  });

  it('retries with backoff and resumes from the last confirmed chunk', async () => {
    const s = setup({ failChunkOnce: true });
    await s.engine.enqueue(recording());
    await s.engine.process();
    const [item] = await s.engine.items();
    expect(item).toMatchObject({
      state: 'pending',
      attempts: 1,
      uploadedSeqs: [0],
      sessionId: 's1',
    });
    await s.engine.process();
    expect(s.calls.filter((c) => c === 'complete')).toHaveLength(0); // not due yet
    s.advance(5_000);
    await s.engine.process();
    expect(s.calls.filter((c) => c.startsWith('init'))).toHaveLength(1);
    expect(s.calls.slice(-3)).toEqual(['url:1', 'put', 'complete']);
  });

  it('stops retrying when consent is rejected', async () => {
    const s = setup();
    (s.api.init as jest.Mock).mockRejectedValueOnce(
      new ApiError(422, 'VALIDATION_FAILED', 'x', undefined, 'CONSENT_REQUIRED'),
    );
    await s.engine.enqueue(recording());
    await s.engine.process();
    const [item] = await s.engine.items();
    expect(item?.state).toBe('failed');
    expect(item?.lastError).toMatch(/consent/i);
    expect(await s.engine.status()).toMatchObject({ failed: 1 });
  });

  it('keeps the item as done when the local delete cannot be verified', async () => {
    const s = setup({ leftover: true });
    await s.engine.enqueue(recording());
    await s.engine.process();
    const [item] = await s.engine.items();
    expect(item?.state).toBe('done');
    expect(s.calls.filter((c) => c === 'complete')).toHaveLength(1);
  });

  it('warns near and enforces the 7-day retention cap', async () => {
    const s = setup();
    s.setOnline(false);
    await s.engine.enqueue(recording());
    s.advance(RETENTION_WARNING_MS);
    expect(await s.engine.status()).toMatchObject({ expiringSoon: 1 });
    s.advance(RETENTION_MS - RETENTION_WARNING_MS);
    await s.engine.process();
    expect(await s.engine.items()).toEqual([]);
    expect(s.files.has('r1')).toBe(false);
  });

  it('wipes everything on logout and aborts open sessions', async () => {
    const s = setup({ failChunkOnce: true });
    await s.engine.enqueue(recording('r1'));
    await s.engine.enqueue(recording('r2'));
    await s.engine.process();
    await s.engine.wipe();
    expect(s.saved()).toEqual([]);
    expect(s.files.size).toBe(0);
    expect(s.calls).toContain('abort:user_stopped');
  });

  it('rejects an empty recording', async () => {
    await expect(setup().engine.enqueue({ ...recording(), chunks: [] })).rejects.toThrow();
  });
});

describe('HTTP recording upload API', () => {
  const ok = (status: number, body?: unknown) =>
    ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as Response;

  it('uses Bearer for API calls and sends signed headers verbatim to storage', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(ok(201, { sessionId: 's1' }))
      .mockResolvedValueOnce(ok(200));
    const api = createHttpRecordingUploadApi({
      baseUrl: 'https://api.example',
      getAccessToken: async () => 'tok',
      fetchImpl,
    });
    await api.init('org 1', { ...recording(), source: 'mobile' } as never);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.example/orgs/org%201/recording-sessions');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer tok');
    await api.put(
      {
        url: 'https://s3/x',
        method: 'PUT',
        headers: { 'content-length': '3', 'x-amz-checksum-sha256': 'abc=' },
        expiresAt: '',
      },
      new Uint8Array([1, 2, 3]),
    );
    const [, putInit] = fetchImpl.mock.calls[1];
    expect(putInit.headers).toEqual({ 'x-amz-checksum-sha256': 'abc=' });
    expect(putInit.credentials).toBe('omit');
  });

  it('refuses non-TLS upload URLs', async () => {
    const api = createHttpRecordingUploadApi({
      baseUrl: 'https://api.example',
      getAccessToken: async () => null,
      fetchImpl: jest.fn(),
    });
    await expect(
      api.put(
        { url: 'http://s3/x', method: 'PUT', headers: { 'content-length': '0' }, expiresAt: '' },
        new Uint8Array(),
      ),
    ).rejects.toThrow(/TLS/);
  });
});
