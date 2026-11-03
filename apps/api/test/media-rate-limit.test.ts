import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import type { RateLimiter } from '../src/modules/auth/domain/ports.js';
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

/** Wraps a limiter: records every key consumed, and can be switched to throw (Redis down). */
function spyLimiter(inner: RateLimiter) {
  const keys: string[] = [];
  let down = false;
  const limiter: RateLimiter = {
    consume: async (key, limit, windowMs) => {
      keys.push(key);
      if (down) throw new Error('ECONNREFUSED redis');
      return inner.consume(key, limit, windowMs);
    },
  };
  return { limiter, keys, setDown: (v: boolean) => (down = v) };
}

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;

async function setup(mediaRateLimits?: MediaRateLimits) {
  const clock = limiterClock();
  const spy = spyLimiter(clock.limiter);
  const w = await mediaWorld({
    extensionIds: [EXT],
    rateLimiter: spy.limiter,
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
  /** Pair the member's extension (ADR-005) and return a bearer request helper that can set the client IP. */
  const extension = async (c: Client = w.member) => {
    const deviceId = randomUUID();
    const nonce = createHash('sha256').update(randomUUID()).digest('base64url');
    const pair = await c.post(EXTENSION_AUTH_PATHS.pair, { extensionId: EXT, deviceId, nonce });
    expect(pair.statusCode).toBe(200);
    const { pairingCode } = pair.json<{ pairingCode: string }>();
    const tok = await w.app.inject({
      method: 'POST',
      url: EXTENSION_AUTH_PATHS.token,
      headers: { origin: EXT_ORIGIN },
      payload: { extensionId: EXT, deviceId, pairingCode, nonce },
    });
    expect(tok.statusCode).toBe(200);
    const { accessToken } = tok.json<{ accessToken: string }>();
    return (url: string, payload: Record<string, unknown>, ip = '127.0.0.1') =>
      w.app.inject({
        method: 'POST',
        url,
        payload,
        remoteAddress: ip,
        headers: { origin: EXT_ORIGIN, authorization: `Bearer ${accessToken}` },
      });
  };
  return { ...w, ...clock, ...spy, meetingId, start, chunk, repo, extension };
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
    // Session b has its own session bucket but shares the user bucket. User buckets are charged before the
    // ownership check, so a's session-rejected request counted too (4 of 5 used).
    expect((await s.chunk(b, 0)).statusCode).toBe(200);
    expect((await s.chunk(b, 1)).statusCode).toBe(429);
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

  it('P1: a user from another org hammering session X neither drains X nor passes the ownership check', async () => {
    const s = await setup({
      ...MEDIA_RATE_LIMITS,
      chunkPerSessionIp: { limit: 3, windowMs: 30_000 },
    });
    w = s;
    const x = await s.start();
    const before = s.keys.length;
    for (let seq = 0; seq < 50; seq++) {
      const r = await s.chunk(x, seq, s.other);
      // Same answer as a non-existent session; never 429 from X's bucket and never a signed URL.
      expect(r.statusCode).toBe(404);
    }
    // Only the attacker's own per-user buckets were charged; no key names session X.
    const foreign = s.keys.slice(before);
    expect(foreign.length).toBeGreaterThan(0);
    expect(foreign.some((k) => k.includes(x))).toBe(false);
    expect(s.repo.rows.get(x)!.chunks.size).toBe(0);
    // X's owner still has the full session bucket.
    for (let seq = 0; seq < 3; seq++) expect((await s.chunk(x, seq)).statusCode).toBe(200);
    expect((await s.chunk(x, 3)).statusCode).toBe(429);
    // The session key is scoped to the owner's org + user.
    const sessionKey = s.keys.find((k) => k.includes(`session:${x}`))!;
    expect(sessionKey).toContain(`org:${s.org}:user:`);
  });

  it('fails closed with 503 + Retry-After when the rate limiter (Redis) is unavailable', async () => {
    const s = await setup();
    w = s;
    const x = await s.start();
    s.setDown(true);
    const ch = await s.chunk(x, 0);
    expect(ch.statusCode).toBe(503);
    expect(errorOf(ch).code).toBe('PROVIDER_UNAVAILABLE');
    expect(Number(ch.headers['retry-after'])).toBe(5);
    expect(s.repo.rows.get(x)!.chunks.size).toBe(0);
    const up = await s.member.post(`/orgs/${s.org}/uploads`, {
      filename: 'call.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1000,
      checksumSha256: SHA_B64,
      consent: consent(),
    });
    expect(up.statusCode).toBe(503);
    expect(Number(up.headers['retry-after'])).toBe(5);
    s.setDown(false);
    expect((await s.chunk(x, 0)).statusCode).toBe(200);
  });

  it('extension bearer: the per-user bucket holds across rotating IPs; per-IP buckets alone would not', async () => {
    const s = await setup({
      ...MEDIA_RATE_LIMITS,
      chunkPerUser: { limit: 10, windowMs: 30_000 },
      chunkPerUserIp: { limit: 4, windowMs: 30_000 },
    });
    w = s;
    const ext = await s.extension();
    const init = await ext(`/orgs/${s.org}/recording-sessions`, {
      mimeType: 'video/webm',
      startedAt: new Date().toISOString(),
      source: 'tab',
      meetingId: s.meetingId,
      consent: consent(),
    });
    expect(init.statusCode).toBe(201);
    const { sessionId } = init.json<{ sessionId: string }>();
    const chunk = (seq: number, ip: string) =>
      ext(`/recording-sessions/${sessionId}/chunks`, { seq, sizeBytes: 1000, sha256: SHA }, ip);
    // Same IP: the per-user+IP bucket trips at 4 (bearer path, 429 + Retry-After).
    for (let seq = 0; seq < 4; seq++) expect((await chunk(seq, '10.0.0.1')).statusCode).toBe(200);
    const sameIp = await chunk(4, '10.0.0.1');
    expect(sameIp.statusCode).toBe(429);
    expect(Number(sameIp.headers['retry-after'])).toBeGreaterThan(0);
    // A new IP per request: 5 more pass (10 total charged to the user), then the IP-independent bucket trips.
    for (let seq = 4; seq < 9; seq++)
      expect((await chunk(seq, `10.0.1.${seq}`)).statusCode).toBe(200);
    expect((await chunk(9, '10.0.2.1')).statusCode).toBe(429);
    expect(s.keys.some((k) => /^media:chunk:user:[^:]+$/.test(k))).toBe(true);
  });
});
