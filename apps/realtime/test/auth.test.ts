/**
 * MR-1 / XT-23 (ADR-011 sections 1 and 4): handshake auth, credential rules, org-room policy and meeting access.
 * Uses a fake verifier; the Prisma meeting lookup is covered in meeting-access.test.ts with a fake client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REALTIME_CONTROL_EVENTS,
  denyAllVerifier,
  type AuthContext,
  type RealtimeCredential,
} from '../src/index.js';
import {
  COOKIE,
  EXT_ORIGIN,
  MEETING_A,
  MEETING_B,
  MEETING_MISSING,
  ORG_A,
  connect,
  connected,
  ext,
  fakeVerifier,
  nextEvent,
  roomsOf,
  runCleanups,
  start,
  web,
} from './fixtures.js';

afterEach(runCleanups);
const reject = (p: Promise<void>) => expect(p).rejects.toThrow('unauthorized');

describe('handshake authentication (ADR-011 section 1)', () => {
  it('rejects an unauthenticated handshake', async () => {
    const { url } = await start();
    await reject(connected(connect(url)));
    await reject(connected(connect(url, { origin: EXT_ORIGIN })));
  });

  it('rejects unknown credentials with the same generic error', async () => {
    const { url } = await start();
    await reject(connected(web(url, 'nope')));
    await reject(connected(ext(url, 'nope')));
  });

  it('connects a valid web cookie and passes only the cookie to the verifier', async () => {
    const seen: RealtimeCredential[] = [];
    const { url } = await start({ verifySession: (c) => (seen.push(c), fakeVerifier(c)) });
    await connected(web(url, 'a1'));
    expect(seen).toEqual([{ cookie: 'a1' }]);
  });

  it('reads the session cookie among others, and rejects a duplicated one', async () => {
    const { url } = await start();
    await connected(connect(url, { cookieHeader: `theme=dark; ${COOKIE}=a1; x=y` }));
    await reject(connected(connect(url, { cookieHeader: `${COOKIE}=a1; ${COOKIE}=b1` })));
    await reject(connected(connect(url, { cookieHeader: 'meetops_sid=a1' })));
  });

  it('connects a valid extension bearer from an allowlisted extension origin', async () => {
    const seen: RealtimeCredential[] = [];
    const { url } = await start({ verifySession: (c) => (seen.push(c), fakeVerifier(c)) });
    await connected(ext(url, 'xa1'));
    expect(seen).toEqual([{ bearer: 'xa1' }]);
  });

  it('rejects a token on a web-origin handshake, even with a valid cookie (1.1)', async () => {
    const { url } = await start();
    await reject(connected(connect(url, { token: 'xa1' })));
    await reject(connected(connect(url, { cookie: 'a1', token: 'xa1' })));
  });

  it('rejects a bearer handshake that also carries a session cookie (1.2)', async () => {
    const { url } = await start();
    await reject(connected(connect(url, { origin: EXT_ORIGIN, token: 'xa1', cookie: 'a1' })));
    await reject(
      connected(connect(url, { origin: EXT_ORIGIN, token: 'xa1', cookieHeader: 'meetops_sid=a1' })),
    );
    await reject(connected(connect(url, { origin: EXT_ORIGIN, cookie: 'a1' })));
  });

  it('rejects credentials in the query string and never verifies them (1.2)', async () => {
    const verify = vi.fn(fakeVerifier);
    const { url } = await start({ verifySession: verify });
    await reject(connected(connect(url, { cookie: 'a1', query: { token: 'xa1' } })));
    await reject(
      connected(connect(url, { origin: EXT_ORIGIN, token: 'xa1', query: { access_token: 'xa1' } })),
    );
    await reject(connected(connect(url, { cookie: 'a1', query: { anything: '1' } })));
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a non-string token', async () => {
    const { url } = await start();
    await reject(connected(connect(url, { origin: EXT_ORIGIN, token: { t: 'xa1' } })));
  });

  it('rejects an extension token without recordings:write, and a class mismatch (1.3)', async () => {
    const { url } = await start();
    await reject(connected(ext(url, 'xnoscope')));
    await reject(connected(ext(url, 'xsession')));
    const cookieIsExtension = await start({
      verifySession: (): AuthContext => ({
        userId: 'u1',
        organizationId: ORG_A,
        sessionId: 's',
        credential: 'extension',
        scopes: ['recordings:write'],
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    await reject(connected(web(cookieIsExtension.url, 'a1')));
  });

  it('rejects a desktop credential on both web and extension handshakes (fail closed)', async () => {
    const desktop = await start({
      verifySession: (): AuthContext => ({
        userId: 'u1',
        organizationId: ORG_A,
        sessionId: 's',
        credential: 'desktop',
        scopes: ['recordings:write'],
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    await reject(connected(web(desktop.url, 'a1')));
    await reject(connected(ext(desktop.url, 'xa1')));
  });

  it('rejects an already-expired or malformed verifier answer', async () => {
    const past = await start({
      verifySession: (): AuthContext => ({
        userId: 'u1',
        organizationId: ORG_A,
        sessionId: 's',
        credential: 'session',
        expiresAt: new Date(Date.now() - 1),
      }),
    });
    await reject(connected(web(past.url, 'a1')));
    const partial = await start({
      verifySession: () => ({ userId: 'u1', organizationId: ORG_A }) as never,
    });
    await reject(connected(web(partial.url, 'a1')));
  });

  it('fails closed when the verifier throws or rejects', async () => {
    const thrown = await start({
      verifySession: () => {
        throw new Error('db down');
      },
    });
    await reject(connected(web(thrown.url, 'a1')));
    const rejected = await start({ verifySession: () => Promise.reject(new Error('db down')) });
    await reject(connected(ext(rejected.url, 'xa1')));
  });

  it('denyAllVerifier rejects everything', async () => {
    const { url } = await start({ verifySession: denyAllVerifier });
    await reject(connected(web(url, 'a1')));
  });
});

describe('rooms and meeting access (ADR-011 sections 1.3 and 4)', () => {
  it('auto-joins the org room for cookie sockets only; bearer sockets join no org room', async () => {
    const { io, url } = await start();
    const w = web(url, 'a1');
    await connected(w);
    expect(roomsOf(io, 'u1')[0]).toContain(`organizations:${ORG_A}`);
    w.disconnect();

    const x = ext(url, 'xa1');
    await connected(x);
    const [rooms] = roomsOf(io, 'u1').filter((r) => !r.includes(`organizations:${ORG_A}`));
    expect(rooms).toHaveLength(1); // only its own socket-id room
    expect(await x.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({ ok: true });
    expect(roomsOf(io, 'u1').flat()).toEqual(
      expect.arrayContaining([`organizations:${ORG_A}:meetings:${MEETING_A}`]),
    );
    expect(roomsOf(io, 'u1').flat()).not.toContain(`organizations:${ORG_A}`);
  });

  it('a bearer socket can only join meetings in its token org', async () => {
    const { url } = await start();
    const x = ext(url, 'xa1');
    await connected(x);
    expect(await x.emitWithAck('meeting:join', { meetingId: MEETING_B })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('refuses a wrong-org meeting and a missing meeting with the identical ack (4.2)', async () => {
    const calls: unknown[] = [];
    const { url } = await start({
      canAccessMeeting: (i) => (
        calls.push(i),
        i.meetingId === MEETING_A && i.organizationId === ORG_A
      ),
    });
    const s = web(url, 'a1');
    await connected(s);
    const wrongOrg = await s.emitWithAck('meeting:join', { meetingId: MEETING_B });
    const missing = await s.emitWithAck('meeting:join', { meetingId: MEETING_MISSING });
    expect(wrongOrg).toEqual({ ok: false, error: 'forbidden' });
    expect(missing).toEqual(wrongOrg);
    // The org always comes from the verified session, never from the client.
    expect(calls).toEqual([
      { organizationId: ORG_A, userId: 'u1', meetingId: MEETING_B },
      { organizationId: ORG_A, userId: 'u1', meetingId: MEETING_MISSING },
    ]);
  });

  it('requires a UUID meeting id and never calls the access check otherwise', async () => {
    const access = vi.fn(() => true);
    const { url } = await start({ canAccessMeeting: access });
    const s = web(url, 'a1');
    await connected(s);
    for (const meetingId of ['mA', '../x', '', `${MEETING_A}x`, 'organizations:x'])
      expect(await s.emitWithAck('meeting:join', { meetingId })).toEqual({
        ok: false,
        error: 'invalid',
      });
    expect(await s.emitWithAck('meeting:join', { meetingId: 42 } as never)).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(access).not.toHaveBeenCalled();
  });

  it('fails closed when the access check throws, and treats non-true as forbidden', async () => {
    const thrown = await start({ canAccessMeeting: () => Promise.reject(new Error('db down')) });
    const s = web(thrown.url, 'a1');
    await connected(s);
    expect(await s.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({
      ok: false,
      error: 'error',
    });
    const truthy = await start({ canAccessMeeting: () => 1 as never });
    const t = web(truthy.url, 'a1');
    await connected(t);
    expect(await t.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

describe('credential expiry', () => {
  it('sends auth:reauth-required { reason: session_expired } at expiry and disconnects', async () => {
    const { url } = await start({
      verifySession: (): AuthContext => ({
        userId: 'u1',
        organizationId: ORG_A,
        sessionId: 's',
        credential: 'session',
        expiresAt: new Date(Date.now() + 300),
      }),
    });
    const s = web(url, 'a1');
    await connected(s);
    const disconnected = new Promise<string>((res) => s.once('disconnect', (r) => res(r)));
    const ev = await nextEvent(s, REALTIME_CONTROL_EVENTS.authReauthRequired, 2_000);
    expect(ev).toMatchObject({ reason: 'session_expired' });
    expect(Object.keys(ev as object).sort()).toEqual(['at', 'reason']);
    expect(await disconnected).toBe('io server disconnect');
  });
});
