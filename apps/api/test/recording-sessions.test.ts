import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ChunkUploadUrlResponse,
  CURRENT_CONSENT_VERSION,
  MAX_CHUNK_BYTES,
  MAX_DURATION_MS,
} from '@meetops/contracts';
import type { InMemoryRecordingSessionRepository } from '../src/modules/media/infrastructure/in-memory.js';
import { consent, errorOf, mediaWorld, type MediaWorld } from './media-helpers.js';
import type { Client } from './helpers.js';

const SHA = 'a'.repeat(64);
const startedAt = () => new Date().toISOString();

async function setup() {
  const w = await mediaWorld();
  const res = await w.member.post(`/orgs/${w.org}/meetings/resolve`, {
    source: 'extension',
    externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
    title: 'Standup',
  });
  const meetingId = res.json<{ meetingId: string }>().meetingId;
  const repo = w.media.sessions as InMemoryRecordingSessionRepository;
  const init = async (c: Client = w.member, over: Record<string, unknown> = {}) =>
    c.post(`/orgs/${w.org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: startedAt(),
      source: 'tab',
      meetingId,
      consent: consent(),
      ...over,
    });
  const start = async (c: Client = w.member) =>
    (await init(c)).json<{ sessionId: string }>().sessionId;
  const chunk = (c: Client, id: string, seq: number, sizeBytes = 1000) =>
    c.post(`/recording-sessions/${id}/chunks`, { seq, sizeBytes, sha256: SHA });
  const upload = (id: string, seq: number, size = 1000) =>
    w.signer.put(repo.rows.get(id)!.chunks.get(seq)!.key, size);
  return { ...w, meetingId, repo, init, start, chunk, upload };
}
type W = MediaWorld & Awaited<ReturnType<typeof setup>>;

const complete = (w: W, c: Client, id: string, body: Record<string, unknown>) =>
  c.post(`/recording-sessions/${id}/complete`, body);

describe('recording sessions', () => {
  it('init 201 {sessionId}; records consent; missing/bad consent 422 and creates nothing', async () => {
    const w = await setup();
    const r = await w.init();
    expect(r.statusCode).toBe(201);
    const { sessionId } = r.json<{ sessionId: string }>();
    expect(w.consents.rows.at(-1)).toMatchObject({
      subjectType: 'recording_session',
      subjectId: sessionId,
    });
    const cases: [unknown, string][] = [
      [undefined, 'CONSENT_REQUIRED'],
      [{ nope: 1 }, 'CONSENT_REQUIRED'],
      [consent({ consentVersion: '1999-01' }), 'CONSENT_VERSION_UNSUPPORTED'],
      [consent({ attestedAt: new Date(Date.now() + 3_600_000).toISOString() }), 'CONSENT_INVALID'],
    ];
    for (const [c, reason] of cases) {
      const res = await w.init(w.member, { consent: c });
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'VALIDATION_FAILED', reason });
    }
    expect(w.repo.rows.size).toBe(1);
    expect(CURRENT_CONSENT_VERSION).toBeTruthy();
  });

  it('init: viewer 403, other org 404, unknown meeting 404, bad source 400', async () => {
    const w = await setup();
    expect((await w.init(w.viewer)).statusCode).toBe(403);
    expect((await w.init(w.other)).statusCode).toBe(404);
    expect(
      (await w.init(w.member, { meetingId: '00000000-0000-4000-8000-0000000000ff' })).statusCode,
    ).toBe(404);
    expect((await w.init(w.member, { source: 'screen' })).statusCode).toBe(400);
  });

  it('init accepts every contracts RecordingSource and stores it', async () => {
    const w = await setup();
    for (const source of ['tab', 'mobile', 'desktop'] as const) {
      const r = await w.init(w.member, { source });
      expect(r.statusCode).toBe(201);
      const { sessionId } = r.json<{ sessionId: string }>();
      expect(w.repo.rows.get(sessionId)!.source).toBe(source);
    }
  });

  it('chunks: presigned PUT per contract with base64 checksum; tenancy and ownership', async () => {
    const w = await setup();
    const id = await w.start();
    const r = await w.chunk(w.member, id, 0);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Value.Check(ChunkUploadUrlResponse, body)).toBe(true);
    const b = body as ChunkUploadUrlResponse;
    expect(b.upload.headers['content-length']).toBe('1000');
    expect(b.upload.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(SHA, 'hex').toString('base64'),
    );
    expect(Date.parse(b.upload.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await w.chunk(w.other, id, 1)).statusCode).toBe(404);
    expect((await w.chunk(w.viewer, id, 1)).statusCode).toBe(403);
    expect((await w.chunk(w.member, 'not-a-uuid', 1)).statusCode).toBe(400);
    expect((await w.chunk(w.member, id, 10_000)).statusCode).toBe(400);
    expect((await w.chunk(w.member, id, 1, MAX_CHUNK_BYTES + 1)).statusCode).toBe(400);
  });

  it('running total capped at 1.4 GB (413 PAYLOAD_TOO_LARGE), re-signing a seq replaces its size', async () => {
    const w = await setup();
    const id = await w.start();
    // 20 x 64 MiB = 1_342_177_280 bytes; one more full chunk crosses 1.4e9.
    for (let s = 0; s < 20; s++)
      expect((await w.chunk(w.member, id, s, MAX_CHUNK_BYTES)).statusCode).toBe(200);
    const over = await w.chunk(w.member, id, 20, MAX_CHUNK_BYTES);
    expect(over.statusCode).toBe(413);
    expect(errorOf(over).code).toBe('PAYLOAD_TOO_LARGE');
    expect((await w.chunk(w.member, id, 20, 1_400_000_000 - 20 * MAX_CHUNK_BYTES)).statusCode).toBe(
      200,
    );
    expect(w.repo.rows.get(id)!.totalBytes).toBe(1_400_000_000);
    expect((await w.chunk(w.member, id, 20, 1)).statusCode).toBe(200);
    expect(w.repo.rows.get(id)!.totalBytes).toBe(20 * MAX_CHUNK_BYTES + 1);
  });

  it('complete 202 queues one job; duration > 4 h 400; gaps/mismatch 400; unuploaded 409', async () => {
    const w = await setup();
    const id = await w.start();
    await w.chunk(w.member, id, 0);
    await w.chunk(w.member, id, 2);
    expect((await complete(w, w.member, id, { chunkCount: 2, durationMs: 1 })).statusCode).toBe(
      400,
    );
    await w.chunk(w.member, id, 1);
    expect(
      (await complete(w, w.member, id, { chunkCount: 3, durationMs: MAX_DURATION_MS + 1 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await complete(w, w.member, id, {
          chunkCount: 3,
          durationMs: 1,
          chunks: [{ seq: 0, sha256: 'b'.repeat(64) }],
        })
      ).statusCode,
    ).toBe(400);
    w.upload(id, 0);
    w.upload(id, 1);
    expect((await complete(w, w.member, id, { chunkCount: 3, durationMs: 1 })).statusCode).toBe(
      409,
    );
    w.upload(id, 2);
    expect(w.jobs.jobs).toHaveLength(0);
    const ok = await complete(w, w.member, id, { chunkCount: 3, durationMs: MAX_DURATION_MS });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ status: 'processing' });
    expect(w.jobs.jobs).toEqual([
      expect.objectContaining({
        kind: 'process_recording_session',
        subjectId: id,
        meetingId: w.meetingId,
      }),
    ]);
    expect((await complete(w, w.member, id, { chunkCount: 3, durationMs: 1 })).statusCode).toBe(
      409,
    );
    expect((await w.chunk(w.member, id, 3)).statusCode).toBe(409);
    expect(w.jobs.jobs).toHaveLength(1);
  });

  it('complete 409 when a stored chunk checksum is missing, multipart or different (review B 4.2)', async () => {
    const w = await setup();
    const id = await w.start();
    await w.chunk(w.member, id, 0);
    const key = w.repo.rows.get(id)!.chunks.get(0)!.key;
    for (const stored of ['LCa0a2j/xo/5m0U8HTBBNBNCLXBkg7+g+YpeiGJm564=', null, 'x-3']) {
      w.signer.put(key, 1000, stored);
      expect((await complete(w, w.member, id, { chunkCount: 1, durationMs: 1 })).statusCode).toBe(
        409,
      );
    }
    expect(w.jobs.jobs).toHaveLength(0);
    w.upload(id, 0);
    expect((await complete(w, w.member, id, { chunkCount: 1, durationMs: 1 })).statusCode).toBe(
      202,
    );
  });

  it('complete without a valid stored consent: 422 CONSENT_* and no job', async () => {
    const w = await setup();
    const id = await w.start();
    await w.chunk(w.member, id, 0);
    w.upload(id, 0);
    const row = w.consents.rows.find((r) => r.subjectId === id)!;
    row.consentVersion = '1999-01';
    let r = await complete(w, w.member, id, { chunkCount: 1, durationMs: 5 });
    expect(r.statusCode).toBe(422);
    expect(errorOf(r)).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'CONSENT_VERSION_UNSUPPORTED',
    });
    w.consents.rows.splice(w.consents.rows.indexOf(row), 1);
    r = await complete(w, w.member, id, { chunkCount: 1, durationMs: 5 });
    expect(errorOf(r)).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'CONSENT_REQUIRED' });
    expect(w.jobs.jobs).toHaveLength(0);
    expect(w.repo.rows.get(id)!.status).toBe('uploading');
  });

  it('abort 204 then everything 409; bad reason 400; other user 403', async () => {
    const w = await setup();
    const id = await w.start();
    expect(
      (await w.owner.post(`/recording-sessions/${id}/abort`, { reason: 'nope' })).statusCode,
    ).toBe(400);
    const mine = await w.start(w.owner);
    expect(
      (await w.member.post(`/recording-sessions/${mine}/abort`, { reason: 'error' })).statusCode,
    ).toBe(403);
    const r = await w.member.post(`/recording-sessions/${id}/abort`, { reason: 'consent_revoked' });
    expect(r.statusCode).toBe(204);
    expect(w.repo.rows.get(id)).toMatchObject({
      status: 'aborted',
      abortReason: 'consent_revoked',
    });
    expect(
      (await w.member.post(`/recording-sessions/${id}/abort`, { reason: 'error' })).statusCode,
    ).toBe(409);
    expect((await w.chunk(w.member, id, 0)).statusCode).toBe(409);
    expect(w.jobs.jobs).toHaveLength(0);
  });
});
