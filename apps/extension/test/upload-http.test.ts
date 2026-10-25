import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthService,
  NotPairedError,
  TOKENS_KEY,
  type StoredTokens,
} from '../src/lib/auth/auth-service.js';
import { uploadValidators, validators } from '../src/lib/auth/validate.js';
import { ChunkStore } from '../src/lib/chunk-store.js';
import { drainQueue } from '../src/lib/drain.js';
import { safeErrorMessage } from '../src/lib/redact.js';
import {
  ChunkChecksumMismatchError,
  HttpUploadClient,
  RECORDING_SESSION_PATHS,
  UploadApiError,
  UploadContractError,
  storageWithRetry,
  verifyingStorage,
  type ApiFetch,
} from '../src/lib/upload-http.js';
import { httpStorageTransport, pairedOrganizationId } from '../src/lib/upload-select.js';
import { memoryKV } from '../src/lib/storage.js';
import {
  createFetchTransport,
  hexToBase64,
  sha256Hex,
  uploadChunk,
  type StorageTransport,
} from '../src/lib/upload.js';
import {
  STORAGE,
  authz,
  createFakeUploadApi,
  errorBody,
  jsonBody,
  route,
} from './helpers/fake-upload-api.js';

const API = 'https://api.meetops.test';
const WEB = 'https://app.meetops.test';
const ORG = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const SID = '7d9f2c1e-3b4a-4c5d-8e6f-0a1b2c3d4e5f';
const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const T0 = Date.parse('2026-10-25T08:00:00.000Z');
const ACCESS = 'A'.repeat(43);

const initReq = {
  mimeType: 'audio/webm;codecs=opus',
  startedAt: '2026-10-25T08:00:00.000Z',
  source: 'tab' as const,
  meetingId: MID,
};

/** No real waiting: sleeps are recorded. */
function fastRetry() {
  const sleeps: number[] = [];
  return {
    sleeps,
    retry: { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, now: () => T0 },
  };
}

/** HttpUploadClient over the typed fake (api = fake.fetch; storage = fetch transport on the same fake). */
function setup(o: { ttlMs?: number; storage?: (s: StorageTransport) => StorageTransport } = {}) {
  let now = T0;
  const fake = createFakeUploadApi({ sessionId: SID, now: () => now, ttlMs: o.ttlMs });
  const api: ApiFetch = (path, init) => fake.fetch(`${API}${path}`, init);
  const { sleeps, retry } = fastRetry();
  const put: StorageTransport = async (req) => {
    const r = await fake.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    return { status: r.status };
  };
  const client = new HttpUploadClient({
    api,
    organizationId: async () => ORG,
    storage: o.storage ? o.storage(put) : put,
    validators: uploadValidators,
    retry,
  });
  return { fake, client, sleeps, advance: (ms: number) => (now += ms), nowMs: () => now };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HttpUploadClient: contracts paths and payloads', () => {
  it('is durable and posts each op to its recording-session route with the contract body', async () => {
    const { fake, client } = setup();
    expect(client.durable).toBe(true);
    expect(await client.initSession(initReq)).toEqual({ sessionId: SID });
    const body = new Blob([new Uint8Array([1, 2, 3])]);
    const chunk = await uploadChunk(client, SID, 0, body, () => T0);
    expect(
      await client.complete(SID, { chunkCount: 1, chunks: [chunk], durationMs: 5000 }),
    ).toEqual({
      status: 'uploaded',
    });
    await client.abort(SID, { reason: 'user_stopped' });

    expect(fake.calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([
      ['POST', `/orgs/${ORG}/recording-sessions`],
      ['POST', `/recording-sessions/${SID}/chunks`],
      ['PUT', `/put/${SID}/0`],
      ['POST', `/recording-sessions/${SID}/complete`],
      ['POST', `/recording-sessions/${SID}/abort`],
    ]);
    expect(jsonBody(fake.of('init')[0]!)).toEqual(initReq);
    const sha = await sha256Hex(body);
    expect(jsonBody(fake.of('chunks')[0]!)).toEqual({ seq: 0, sizeBytes: 3, sha256: sha });
    expect(jsonBody(fake.of('complete')[0]!)).toEqual({
      chunkCount: 1,
      chunks: [{ seq: 0, sha256: sha, sizeBytes: 3 }],
      durationMs: 5000,
    });
    expect(jsonBody(fake.of('abort')[0]!)).toEqual({ reason: 'user_stopped' });
    for (const c of fake.calls.filter((c) => c.init.method === 'POST')) {
      expect(new Headers(c.init.headers).get('content-type')).toBe('application/json');
    }
    // The PUT carries the signed base64 checksum of the body.
    expect(fake.objects.get(0)).toEqual({ bytes: 3, checksum: hexToBase64(sha) });
  });

  it('percent-encodes path segments', () => {
    expect(RECORDING_SESSION_PATHS.init('a/b')).toBe('/orgs/a%2Fb/recording-sessions');
    expect(RECORDING_SESSION_PATHS.chunks('x?y')).toBe('/recording-sessions/x%3Fy/chunks');
  });

  it('validates requests against contracts before sending anything', async () => {
    const { fake, client } = setup();
    await expect(client.initSession({ ...initReq, meetingId: 'nope' })).rejects.toBeInstanceOf(
      UploadContractError,
    );
    await expect(
      client.requestChunkUrl(SID, { seq: 0, sizeBytes: 1, sha256: 'ABC' }),
    ).rejects.toBeInstanceOf(UploadContractError);
    await expect(client.complete(SID, { chunkCount: 0, durationMs: 0 })).rejects.toBeInstanceOf(
      UploadContractError,
    );
    await expect(
      client.abort(SID, { reason: 'bogus' as unknown as 'error' }),
    ).rejects.toBeInstanceOf(UploadContractError);
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects responses that fail contract validation (not retried)', async () => {
    const { fake, client } = setup();
    fake.reply('init', { status: 201, body: { sessionId: 'not-a-uuid' } });
    await expect(client.initSession(initReq)).rejects.toBeInstanceOf(UploadContractError);
    fake.reply('complete', { status: 200, body: { status: 'weird' } });
    await expect(client.complete(SID, { chunkCount: 1, durationMs: 1 })).rejects.toBeInstanceOf(
      UploadContractError,
    );
    fake.reply('init', { status: 201, body: 'not json' });
    await expect(client.initSession(initReq)).rejects.toBeInstanceOf(UploadContractError);
    expect(fake.of('init')).toHaveLength(2);
  });

  it('rejects a chunk URL issued for another seq', async () => {
    const { fake, client } = setup();
    const sha = 'a'.repeat(64);
    fake.reply('chunks', {
      status: 200,
      body: {
        seq: 1,
        upload: {
          url: `${STORAGE}/put/${SID}/1`,
          method: 'PUT',
          headers: { 'content-length': '1', 'x-amz-checksum-sha256': hexToBase64(sha) },
          expiresAt: new Date(T0 + 60_000).toISOString(),
        },
      },
    });
    await expect(
      client.requestChunkUrl(SID, { seq: 0, sizeBytes: 1, sha256: sha }),
    ).rejects.toBeInstanceOf(UploadContractError);
  });
});

describe('HttpUploadClient: checksums', () => {
  const grant = (checksum: string | undefined) => ({
    status: 200,
    body: {
      seq: 0,
      upload: {
        url: `${STORAGE}/put/${SID}/0`,
        method: 'PUT',
        headers: {
          'content-length': '3',
          ...(checksum === undefined ? {} : { 'x-amz-checksum-sha256': checksum }),
        },
        expiresAt: new Date(T0 + 600_000).toISOString(),
      },
    },
  });

  it('refuses a URL whose signed checksum is missing or not the request sha256', async () => {
    const { fake, client } = setup();
    const sha = 'b'.repeat(64);
    fake.reply('chunks', grant(hexToBase64('c'.repeat(64))), grant(undefined));
    for (let i = 0; i < 2; i++) {
      await expect(
        client.requestChunkUrl(SID, { seq: 0, sizeBytes: 3, sha256: sha }),
      ).rejects.toBeInstanceOf(ChunkChecksumMismatchError);
    }
    expect(fake.of('put')).toHaveLength(0);
  });

  it('verifyingStorage refuses a body that does not hash to the signed checksum, before any PUT', async () => {
    const inner = vi.fn<StorageTransport>(async () => ({ status: 200 }));
    const t = verifyingStorage(inner);
    const body = new Blob([new Uint8Array([1, 2, 3])]);
    const other = hexToBase64(await sha256Hex(new Blob([new Uint8Array([9])])));
    const req = (h: Record<string, string>) => ({
      url: `${STORAGE}/x`,
      method: 'PUT' as const,
      headers: h,
      body,
    });
    await expect(t(req({ 'x-amz-checksum-sha256': other }))).rejects.toBeInstanceOf(
      ChunkChecksumMismatchError,
    );
    await expect(t(req({}))).rejects.toBeInstanceOf(ChunkChecksumMismatchError);
    expect(inner).not.toHaveBeenCalled();
    const good = hexToBase64(await sha256Hex(body));
    await expect(t(req({ 'X-Amz-Checksum-Sha256': good }))).resolves.toEqual({ status: 200 });
  });

  it('a stale stored digest fails the chunk instead of uploading mismatched bytes', async () => {
    const { fake, client } = setup({ storage: verifyingStorage });
    const body = new Blob([new Uint8Array([1, 2, 3])]);
    await expect(
      uploadChunk(client, SID, 0, body, () => T0, 'd'.repeat(64)),
    ).rejects.toBeInstanceOf(ChunkChecksumMismatchError);
    expect(fake.of('put')).toHaveLength(0);
  });
});

describe('HttpUploadClient: expired URLs', () => {
  it('re-requests the URL after a storage 403 and retries the PUT once', async () => {
    const { fake, client } = setup();
    fake.reply('put', { status: 403 });
    await uploadChunk(client, SID, 0, new Blob([new Uint8Array([1])]), () => T0);
    expect(fake.ops()).toEqual(['chunks', 'put', 'chunks', 'put']);
  });

  it('re-requests a URL that is already about to expire', async () => {
    const { fake, client } = setup({ ttlMs: 5_000 });
    await uploadChunk(client, SID, 0, new Blob([new Uint8Array([1])]), () => T0);
    expect(fake.ops()).toEqual(['chunks', 'chunks', 'put']);
  });
});

describe('HttpUploadClient: retries and backoff', () => {
  it('retries 5xx with exponential backoff and jitter, then succeeds', async () => {
    const { fake, client, sleeps } = setup();
    fake.reply(
      'init',
      { status: 503, body: errorBody('PROVIDER_UNAVAILABLE') },
      { status: 502 },
      { status: 500 },
    );
    expect(await client.initSession(initReq)).toEqual({ sessionId: SID });
    expect(fake.of('init')).toHaveLength(4);
    // base 500, equal jitter at random()=0.5: 375, 750, 1500.
    expect(sleeps).toEqual([375, 750, 1500]);
  });

  it('gives up after maxAttempts with UploadApiError carrying the contract error code', async () => {
    const { fake, client } = setup();
    const r = { status: 503, body: errorBody('PROVIDER_UNAVAILABLE') };
    fake.reply('complete', r, r, r, r, r);
    const err = await client
      .complete(SID, { chunkCount: 1, durationMs: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadApiError);
    expect(err).toMatchObject({ op: 'complete', status: 503, code: 'PROVIDER_UNAVAILABLE' });
    expect(fake.of('complete')).toHaveLength(4);
  });

  it('honours Retry-After on 429 (seconds) instead of the computed backoff', async () => {
    const { fake, client, sleeps } = setup();
    fake.reply('chunks', {
      status: 429,
      body: errorBody('RATE_LIMITED'),
      headers: { 'retry-after': '2' },
    });
    await client.requestChunkUrl(SID, { seq: 0, sizeBytes: 1, sha256: 'e'.repeat(64) });
    expect(sleeps).toEqual([2000]);
  });

  it('does not wait out a Retry-After beyond the cap; the drain retries later', async () => {
    const { fake, client, sleeps } = setup();
    fake.reply('init', {
      status: 429,
      body: errorBody('RATE_LIMITED'),
      headers: { 'retry-after': '120' },
    });
    await expect(client.initSession(initReq)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 120_000,
    });
    expect(sleeps).toEqual([]);
  });

  it('retries network errors (fetch TypeError)', async () => {
    const { fake, client, sleeps } = setup();
    fake.reply('init', new TypeError('Failed to fetch'));
    expect(await client.initSession(initReq)).toEqual({ sessionId: SID });
    expect(sleeps).toHaveLength(1);
  });

  it('does not retry non-transient 4xx', async () => {
    for (const [status, code] of [
      [400, 'VALIDATION_FAILED'],
      [401, 'UNAUTHENTICATED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
    ] as const) {
      const { fake, client, sleeps } = setup();
      fake.reply('complete', { status, body: errorBody(code) });
      await expect(client.complete(SID, { chunkCount: 1, durationMs: 1 })).rejects.toMatchObject({
        status,
        code,
      });
      expect(fake.of('complete')).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('maps a non-envelope error body to INVALID_RESPONSE', async () => {
    const { fake, client } = setup();
    fake.reply('init', { status: 400, body: { message: 'nope' } });
    await expect(client.initSession(initReq)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('abort resolves on 204, 404 and 409 (nothing left to abort) but surfaces other failures', async () => {
    const { fake, client } = setup();
    await client.abort(SID, { reason: 'error' });
    fake.reply(
      'abort',
      { status: 404, body: errorBody('NOT_FOUND') },
      { status: 409, body: errorBody('CONFLICT') },
    );
    await client.abort(SID, { reason: 'error' });
    await client.abort(SID, { reason: 'error' });
    fake.reply('abort', { status: 400, body: errorBody('BAD_REQUEST') });
    await expect(client.abort(SID, { reason: 'error' })).rejects.toBeInstanceOf(UploadApiError);
  });

  it('storageWithRetry retries transient PUT statuses and network errors but returns 403 at once', async () => {
    const { sleeps, retry } = fastRetry();
    const inner = vi
      .fn<StorageTransport>()
      .mockResolvedValueOnce({ status: 503 })
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce({ status: 200 });
    const req = { url: `${STORAGE}/x`, method: 'PUT' as const, headers: {}, body: new Blob(['x']) };
    expect(await storageWithRetry(inner, retry)(req)).toEqual({ status: 200 });
    expect(inner).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);

    const forbidden = vi.fn<StorageTransport>(async () => ({ status: 403 }));
    expect(await storageWithRetry(forbidden, retry)(req)).toEqual({ status: 403 });
    expect(forbidden).toHaveBeenCalledTimes(1);

    const down = vi.fn<StorageTransport>(async () => ({ status: 500 }));
    expect(await storageWithRetry(down, { ...retry, maxAttempts: 2 })(req)).toEqual({
      status: 500,
    });
    expect(down).toHaveBeenCalledTimes(2);
  });
});

describe('HttpUploadClient: offline queue (drainQueue + ChunkStore)', () => {
  it('keeps chunks while offline, uploads and deletes them (durable) on a later drain', async () => {
    const { fake, client } = setup();
    const store = await ChunkStore.open({ maxBytes: 10_000, policy: 'refuse' }, new IDBFactory());
    await store.putSession({
      sessionId: SID,
      meta: { ...initReq, startedAt: initReq.startedAt },
      completed: false,
    });
    for (const seq of [0, 1]) {
      await store.putChunk({
        sessionId: SID,
        seq,
        data: new Uint8Array([seq + 1, 7]).buffer,
        mimeType: initReq.mimeType,
        createdAt: T0 + seq,
      });
    }
    await store.finalizeSession(SID, { chunkCount: 2, durationMs: 10_000 });

    // Offline: every attempt fails at the network layer.
    const offline = new TypeError('Failed to fetch');
    fake.reply('chunks', offline, offline, offline, offline);
    const first = await drainQueue(store, client);
    expect(first.failed).toBe(1);
    expect(first.completed).toBe(0);
    expect(await store.listChunks(SID)).toHaveLength(2);

    // Back online.
    const second = await drainQueue(store, client);
    expect(second).toMatchObject({ uploaded: 2, completed: 1, failed: 0 });
    expect(await store.listChunks(SID)).toHaveLength(0);
    expect(fake.objects.size).toBe(2);
    expect(jsonBody(fake.of('complete').at(-1)!)).toMatchObject({
      chunkCount: 2,
      durationMs: 10_000,
    });
  });
});

describe('ADR-005 auth: bearer through AuthService.apiFetch only', () => {
  function authed(tokens: Partial<StoredTokens> | undefined) {
    const fake = createFakeUploadApi({ sessionId: SID, now: () => T0 });
    const session = memoryKV();
    const auth = new AuthService({
      session,
      install: memoryKV(),
      config: { webOrigin: WEB, apiOrigin: API },
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      now: () => T0,
      fetch: fake.fetch,
      randomBytes: (n) => new Uint8Array(n).fill(7),
      randomUUID: () => '0b5a3c4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
      openTab: async () => {},
      validators,
      alarms: { schedule: async () => {}, clear: async () => {} },
    });
    const ready = tokens
      ? session.set(TOKENS_KEY, {
          accessToken: ACCESS,
          refreshToken: 'R'.repeat(43),
          expiresAt: T0 + 900_000,
          refreshExpiresAt: T0 + 30 * 86_400_000,
          organizationId: ORG,
          scopes: ['meetings:resolve', 'recordings:write'],
          ...tokens,
        })
      : Promise.resolve();
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => fake.fetch(url, init));
    const { retry } = fastRetry();
    const client = new HttpUploadClient({
      api: (p, i) => auth.apiFetch(p, i),
      organizationId: pairedOrganizationId(auth),
      storage: httpStorageTransport({ allowLocalHttp: false, retry }),
      validators: uploadValidators,
      retry,
    });
    return { fake, client, ready };
  }

  it('API calls carry the bearer on the API origin; presigned PUTs never do', async () => {
    const { fake, client, ready } = authed({});
    await ready;
    await client.initSession(initReq);
    await uploadChunk(client, SID, 0, new Blob([new Uint8Array([4, 5])]), () => T0);
    expect(fake.ops()).toEqual(['init', 'chunks', 'put']);
    for (const c of fake.calls) {
      const u = new URL(c.url);
      if (route(c.url, c.init.method)?.op === 'put') {
        expect(u.origin).toBe(STORAGE);
        expect(authz(c)).toBeNull();
        expect(c.init.credentials).toBe('omit');
      } else {
        expect(u.origin).toBe(API);
        expect(authz(c)).toBe(`Bearer ${ACCESS}`);
      }
    }
    // The org in the path is the paired token's org.
    expect(new URL(fake.of('init')[0]!.url).pathname).toBe(`/orgs/${ORG}/recording-sessions`);
  });

  it('createFetchTransport strips any authorization header a server tried to sign', async () => {
    const { fake, ready } = authed({});
    await ready;
    await createFetchTransport({ allowLocalHttp: false })({
      url: `${STORAGE}/put/${SID}/0`,
      method: 'PUT',
      headers: { Authorization: `Bearer ${ACCESS}`, 'content-length': '1' },
      body: new Blob(['x']),
    });
    expect(authz(fake.calls[0]!)).toBeNull();
  });

  it('refuses to start a session when not paired', async () => {
    const { fake, client } = authed(undefined);
    await expect(client.initSession(initReq)).rejects.toBeInstanceOf(NotPairedError);
    expect(fake.calls).toHaveLength(0);
  });

  it('never leaks the token into errors or the console', async () => {
    const { fake, client, ready } = authed({});
    await ready;
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
    fake.reply('complete', {
      status: 400,
      body: errorBody('BAD_REQUEST', `echo Bearer ${ACCESS}`),
    });
    const err = await client
      .complete(SID, { chunkCount: 1, durationMs: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadApiError);
    const text = `${String(err)} ${(err as Error).stack ?? ''} ${JSON.stringify(err)} ${safeErrorMessage(err)}`;
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain('echo');
    for (const l of logs) {
      for (const args of l.mock.calls) expect(JSON.stringify(args)).not.toContain(ACCESS);
    }
  });
});
