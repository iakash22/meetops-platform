import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/in-memory.js';
import { MEDIA_RATE_LIMITS, type MediaRateLimits } from '../src/modules/media/http/rate-limit.js';
import type { InMemoryRecordingSessionRepository } from '../src/modules/media/infrastructure/in-memory.js';
import { consent, errorOf, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';
import type { Client } from './helpers.js';

const SHA = 'a'.repeat(64);
/** Extension TIMESLICE_MS (apps/extension/src/lib/recorder.ts); desktop uses 10 s, so this is the faster client. */
const EXTENSION_TIMESLICE_MS = 5_000;

/** Rate limiter on its own clock so tests can step through real chunk cadence without real waits. */
function limiterClock() {
  let t = Date.UTC(2026, 10, 3, 12, 0, 0);
  return {
    limiter: new InMemoryRateLimiter({ now: () => new Date(t) }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function setup(mediaRateLimits?: MediaRateLimits) {
  const clock = limiterClock();
  const w = await mediaWorld({
    rateLimiter: clock.limiter,
    ...(mediaRateLimits ? { mediaRateLimits } : {}),
  });
  const meetingId = (
    await w.member.post(`/orgs/${w.org}/meetings/resolve`, {
      source: 'extension',
      externalMeetingUrl: 'https://meet.google.com/abc-defg-hij',
      title: 'Standup',
    })
  ).json<{ meetingId: string }>().meetingId;
  const start = async (c: Client = w.member) => {
    const r = await c.post(`/orgs/${w.org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: new Date().toISOString(),
      source: 'tab',
      meetingId,
      consent: consent(),
    });
    expect(r.statusCode).toBe(201);
    return r.json<{ sessionId: string }>().sessionId;
  };
  const chunk = (id: string, seq: number, c: Client = w.member) =>
    c.post(`/recording-sessions/${id}/chunks`, { seq, sizeBytes: 1000, sha256: SHA });
  const repo = w.media.sessions as InMemoryRecordingSessionRepository;
  return { ...w, ...clock, meetingId, start, chunk, repo };
}

describe('media upload / recording-chunk rate limits', () => {
  let w: MediaWorld | undefined;
  afterEach(async () => w?.app.close());

  it('a normal chunked recording at extension cadence (one chunk per 5 s for 1 h) never hits 429', async () => {
    const s = await setup();
    w = s;
    const id = await s.start();
    for (let seq = 0; seq < 720; seq++) {
      const r = await s.chunk(id, seq);
      expect(r.statusCode, `seq ${seq}`).toBe(200);
      s.advance(EXTENSION_TIMESLICE_MS);
    }
    expect(s.repo.rows.get(id)!.chunks.size).toBe(720);
  });

  it('an offline backlog drained back-to-back fits the per-session window; a burst over it gets 429 + Retry-After', async () => {
    const s = await setup();
    w = s;
    const id = await s.start();
    const limit = MEDIA_RATE_LIMITS.chunkPerSessionIp.limit;
    for (let seq = 0; seq < limit; seq++) expect((await s.chunk(id, seq)).statusCode).toBe(200);
    const over = await s.chunk(id, limit);
    expect(over.statusCode).toBe(429);
    expect(errorOf(over).code).toBe('RATE_LIMITED');
    const retryAfter = Number(over.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    // <= the extension's maxRetryAfterMs (30 s), so the client waits it out instead of failing the drain.
    expect(retryAfter).toBeLessThanOrEqual(30);
    s.advance(retryAfter * 1000);
    expect((await s.chunk(id, limit)).statusCode).toBe(200);
  });

  it('keys chunk limits per session and per user: other sessions / users are unaffected; per-user cap spans sessions', async () => {
    const s = await setup({
      ...MEDIA_RATE_LIMITS,
      chunkPerSessionIp: { limit: 3, windowMs: 30_000 },
      chunkPerUserIp: { limit: 5, windowMs: 30_000 },
    });
    w = s;
    const a = await s.start();
    const b = await s.start();
    for (let seq = 0; seq < 3; seq++) expect((await s.chunk(a, seq)).statusCode).toBe(200);
    expect((await s.chunk(a, 3)).statusCode).toBe(429);
    // Session b has its own session bucket but shares the user bucket (3 of 5 used by a; the session-rejected
    // request is not charged to the user bucket).
    expect((await s.chunk(b, 0)).statusCode).toBe(200);
    expect((await s.chunk(b, 1)).statusCode).toBe(200);
    expect((await s.chunk(b, 2)).statusCode).toBe(429);
    // Another user is not throttled by this user's burst.
    const c = await s.start(s.owner);
    expect((await s.chunk(c, 0, s.owner)).statusCode).toBe(200);
  });

  it('limits upload init/complete and recording-session control routes per user with 429 + Retry-After', async () => {
    const s = await setup({
      ...MEDIA_RATE_LIMITS,
      controlPerUserIp: { limit: 2, windowMs: 30_000 },
    });
    w = s;
    const upload = () =>
      s.member.post(`/orgs/${s.org}/uploads`, {
        filename: 'call.webm',
        mimeType: 'audio/webm',
        sizeBytes: 1000,
        checksumSha256: SHA_B64,
        consent: consent(),
      });
    expect((await upload()).statusCode).toBe(201);
    expect((await upload()).statusCode).toBe(201);
    const r = await upload();
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // Recording-session init shares the same control bucket.
    const init = await s.member.post(`/orgs/${s.org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: new Date().toISOString(),
      source: 'tab',
      meetingId: s.meetingId,
      consent: consent(),
    });
    expect(init.statusCode).toBe(429);
    s.advance(30_000);
    expect((await upload()).statusCode).toBe(201);
    // Owner has an independent bucket.
    const o = await s.owner.post(`/orgs/${s.org}/uploads`, {
      filename: 'call.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    expect(o.statusCode).toBe(201);
  });
});
