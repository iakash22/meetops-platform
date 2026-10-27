import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import type { InMemoryRecordingSessionRepository } from '../src/modules/media/infrastructure/in-memory.js';
import type { App, Client } from './helpers.js';
import { consent, errorOf, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;
const SHA = 'a'.repeat(64);
const nonce = () => createHash('sha256').update(randomUUID()).digest('base64url');

/** Pair `c` (whose active org is the token's org) and return an access token. */
async function tokenFor(app: App, c: Client) {
  const deviceId = randomUUID();
  const n = nonce();
  const pair = await c.post(EXTENSION_AUTH_PATHS.pair, { extensionId: EXT, deviceId, nonce: n });
  expect(pair.statusCode).toBe(200);
  const { pairingCode } = pair.json<{ pairingCode: string }>();
  const tok = await app.inject({
    method: 'POST',
    url: EXTENSION_AUTH_PATHS.token,
    headers: { origin: EXT_ORIGIN },
    payload: { extensionId: EXT, deviceId, pairingCode, nonce: n },
  });
  expect(tok.statusCode).toBe(200);
  return tok.json<{ accessToken: string; refreshToken: string }>();
}

async function world() {
  const w = await mediaWorld({ extensionIds: [EXT] });
  const { accessToken } = await tokenFor(w.app, w.member);
  /** An extension request: chrome-extension origin, Bearer, no cookie and no CSRF header. */
  const ext = (
    method: 'POST' | 'GET',
    url: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    w.app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: { origin: EXT_ORIGIN, authorization: `Bearer ${accessToken}`, ...headers },
    });
  const resolve = (headers: Record<string, string> = {}, org = w.org) =>
    ext(
      'POST',
      `/orgs/${org}/meetings/resolve`,
      {
        source: 'extension',
        externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
        title: 'S',
      },
      headers,
    );
  return { ...w, accessToken, ext, resolve };
}

const sessionBody = (meetingId: string) => ({
  mimeType: 'video/webm',
  startedAt: new Date().toISOString(),
  source: 'tab',
  meetingId,
  consent: consent(),
});

describe('ADR-005 A1.3.1: extension bearer on resolve, recording-session and upload routes', () => {
  it('runs the whole tab recording flow with only a bearer token (no cookie, no CSRF)', async () => {
    const w = await world();
    const r = await w.resolve();
    expect(r.statusCode).toBe(201);
    const { meetingId } = r.json<{ meetingId: string }>();
    const init = await w.ext('POST', `/orgs/${w.org}/recording-sessions`, sessionBody(meetingId));
    expect(init.statusCode).toBe(201);
    const { sessionId } = init.json<{ sessionId: string }>();
    const repo = w.media.sessions as InMemoryRecordingSessionRepository;
    expect(repo.rows.get(sessionId)).toBeTruthy();
    const ch = await w.ext('POST', `/recording-sessions/${sessionId}/chunks`, {
      seq: 0,
      sizeBytes: 1000,
      sha256: SHA,
    });
    expect(ch.statusCode).toBe(200);
    const ab = await w.ext('POST', `/recording-sessions/${sessionId}/abort`, { reason: 'error' });
    expect(ab.statusCode).toBeLessThan(300);
  });

  it('direct upload init accepts the bearer (recordings:write)', async () => {
    const w = await world();
    const r = await w.ext('POST', `/orgs/${w.org}/uploads`, {
      filename: 'call.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    expect(r.statusCode).toBe(201);
  });

  it('bearer plus a session cookie is 401, even with a valid token', async () => {
    const w = await world();
    const r = await w.resolve({ cookie: 'meetops_sid=whatever; __Host-meetops_sid=whatever' });
    expect(r.statusCode).toBe(401);
  });

  it('a bad or revoked-looking token is 401; other org is 404', async () => {
    const w: MediaWorld & Awaited<ReturnType<typeof world>> = await world();
    const bad = await w.app.inject({
      method: 'POST',
      url: `/orgs/${w.org}/meetings/resolve`,
      headers: { origin: EXT_ORIGIN, authorization: `Bearer ${'x'.repeat(43)}` },
      payload: { source: 'extension', externalMeetingUrl: 'https://meet.google.com/a', title: 'S' },
    });
    expect(bad.statusCode).toBe(401);
    expect(errorOf(bad).code).toBe('UNAUTHENTICATED');
    expect((await w.resolve({}, w.otherOrg)).statusCode).toBe(404);
    const sess = await w.ext(
      'POST',
      '/recording-sessions/00000000-0000-4000-8000-0000000000ff/chunks',
      {
        seq: 0,
        sizeBytes: 1000,
        sha256: SHA,
      },
    );
    expect(sess.statusCode).toBe(404);
  });

  it('other routes still reject the bearer (cookie-only): meetings list, download-url', async () => {
    const w = await world();
    expect((await w.ext('GET', `/orgs/${w.org}/meetings`)).statusCode).toBe(401);
    expect(
      (await w.ext('GET', `/orgs/${w.org}/uploads/${randomUUID()}/download-url`)).statusCode,
    ).toBe(401);
  });

  it('the cookie path is unchanged for web clients', async () => {
    const w = await world();
    const r = await w.member.post(`/orgs/${w.org}/meetings/resolve`, {
      source: 'extension',
      externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
      title: 'S',
    });
    expect(r.statusCode).toBe(201);
  });
});
