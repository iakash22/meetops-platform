/**
 * Security finding M2: live sockets are re-verified periodically and on ADR-011 revocation messages, and
 * handshakes are rate limited per IP and per user.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildRevocationMessage } from '@meetops/session-verifier';
import {
  ConnectionRateLimiter,
  REALTIME_CONTROL_EVENTS,
  type AuthContext,
  type RealtimeCredential,
} from '../src/index.js';
import {
  ORG_B,
  connected,
  ext,
  fakeVerifier,
  nextEvent,
  runCleanups,
  start,
  web,
  type C,
} from './fixtures.js';

afterEach(runCleanups);
const reject = (p: Promise<void>) => expect(p).rejects.toThrow('unauthorized');
const disconnectedOf = (s: C) => new Promise<string>((res) => s.once('disconnect', (r) => res(r)));

/** A verifier whose answers can be revoked per credential after the handshake. */
function switchable() {
  const revoked = new Set<string>();
  const override = new Map<string, AuthContext>();
  let throws = false;
  const key = (c: RealtimeCredential) => ('cookie' in c ? `c:${c.cookie}` : `b:${c.bearer}`);
  const verifySession = (c: RealtimeCredential): AuthContext | null => {
    if (throws) throw new Error('db down');
    if (revoked.has(key(c))) return null;
    return override.get(key(c)) ?? fakeVerifier(c);
  };
  return { verifySession, revoked, override, fail: () => (throws = true) };
}

function feed() {
  let listener: ((raw: string) => void) | undefined;
  let unsubscribed = false;
  return {
    subscribeRevocations: (l: (raw: string) => void) => {
      listener = l;
      return () => {
        unsubscribed = true;
      };
    },
    send: (raw: string) => listener?.(raw),
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

describe('periodic re-verification', () => {
  it('disconnects a web socket whose session was revoked, with revalidation_failed', async () => {
    const v = switchable();
    const { url } = await start(v, { REALTIME_REVALIDATE_INTERVAL_MS: '1000' });
    const s = web(url, 'a1');
    await connected(s);
    v.revoked.add('c:a1');
    const gone = disconnectedOf(s);
    const ev = await nextEvent(s, REALTIME_CONTROL_EVENTS.authReauthRequired, 3_000);
    expect(ev).toMatchObject({ reason: 'revalidation_failed' });
    expect(await gone).toBe('io server disconnect');
  });

  it('disconnects an extension socket whose token family was revoked', async () => {
    const v = switchable();
    const { url } = await start(v, { REALTIME_REVALIDATE_INTERVAL_MS: '1000' });
    const s = ext(url, 'xa1');
    await connected(s);
    v.revoked.add('b:xa1');
    expect(await disconnectedOf(s)).toBe('io server disconnect');
  });

  it('keeps a still-valid socket connected', async () => {
    const v = switchable();
    const { url } = await start(v, { REALTIME_REVALIDATE_INTERVAL_MS: '1000' });
    const s = web(url, 'a1');
    await connected(s);
    expect(await nextEvent(s, REALTIME_CONTROL_EVENTS.authReauthRequired, 2_300)).toBe('timeout');
    expect(s.connected).toBe(true);
  });

  it('fails closed when the verifier throws during re-verification', async () => {
    const v = switchable();
    const { url } = await start(v, { REALTIME_REVALIDATE_INTERVAL_MS: '1000' });
    const s = web(url, 'a1');
    await connected(s);
    v.fail();
    expect(await disconnectedOf(s)).toBe('io server disconnect');
  });
});

describe('revocation events (ADR-011 section 3)', () => {
  it('re-verifies only the named session at once and disconnects it', async () => {
    const v = switchable();
    const f = feed();
    const { app } = await start({ ...v, subscribeRevocations: f.subscribeRevocations });
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const a = web(url, 'a1');
    const b = web(url, 'a2');
    await Promise.all([connected(a), connected(b)]);
    v.revoked.add('c:a1');
    v.revoked.add('c:a2');
    const gone = disconnectedOf(a);
    f.send('not json');
    f.send(
      JSON.stringify(
        buildRevocationMessage(
          { kind: 'session', sessionId: 's1', userId: 'u1', reason: 'logout' },
          new Date(),
        ),
      ),
    );
    const ev = await nextEvent(a, REALTIME_CONTROL_EVENTS.authReauthRequired, 500);
    expect(ev).toMatchObject({ reason: 'revalidation_failed' });
    expect(await gone).toBe('io server disconnect');
    // u2 was not named, so it is only caught by the periodic check (60 s default), not now.
    expect(b.connected).toBe(true);
    b.disconnect();
    await app.close();
    expect(f.unsubscribed).toBe(true);
  });

  it('sends org_switch when the session now points at another org', async () => {
    const v = switchable();
    const f = feed();
    const { url } = await start({ ...v, subscribeRevocations: f.subscribeRevocations });
    const s = web(url, 'a1');
    await connected(s);
    v.override.set('c:a1', { ...fakeVerifier({ cookie: 'a1' })!, organizationId: ORG_B });
    f.send(
      JSON.stringify(
        buildRevocationMessage({ kind: 'user', userId: 'u1', reason: 'org_switch' }, new Date()),
      ),
    );
    expect(await nextEvent(s, REALTIME_CONTROL_EVENTS.authReauthRequired, 500)).toMatchObject({
      reason: 'org_switch',
    });
  });
});

describe('connection rate limits', () => {
  it('limits handshakes per IP, before verifying', async () => {
    let calls = 0;
    const { url } = await start(
      { verifySession: (c) => (calls++, fakeVerifier(c)) },
      { REALTIME_CONN_LIMIT_PER_IP: '2' },
    );
    await connected(web(url, 'a1'));
    await connected(web(url, 'a2'));
    await reject(connected(web(url, 'b1')));
    expect(calls).toBe(2);
  });

  it('limits connections per user', async () => {
    const { url } = await start({}, { REALTIME_CONN_LIMIT_PER_USER: '1' });
    await connected(web(url, 'a1'));
    await reject(connected(ext(url, 'xa1'))); // same user u1, different credential
    await connected(web(url, 'a2'));
  });

  it('opens a new window after windowMs', () => {
    let t = 0;
    const l = new ConnectionRateLimiter(1_000, () => t);
    expect([l.take('k', 2), l.take('k', 2), l.take('k', 2)]).toEqual([true, true, false]);
    t = 1_000;
    expect(l.take('k', 2)).toBe(true);
  });
});
