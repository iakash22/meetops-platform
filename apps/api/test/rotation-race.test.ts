/**
 * #459 NB-R3-3: two rotations of the same session at once (a double-submitted POST /orgs). Both requests pass session
 * validation, both create their org, then both rotate. The loser must not 401 after its org was created when the
 * winner is the same client; any other client still gets 401.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import { buildApp, SID, signupAndLogin } from './helpers.js';

/** Holds the first revoke() until a second one arrives, then lets the second run first: a real overlap. */
class OverlappingRevokes extends InMemorySessionRepository {
  private armed = false;
  private secondArrived: (() => void) | null = null;
  private firstMayRun: Promise<void> | null = null;
  arm() {
    this.armed = true;
    let release!: () => void;
    this.firstMayRun = new Promise<void>((r) => (release = r));
    this.secondArrived = release;
  }
  override async revoke(id: string, at: Date) {
    if (this.armed) {
      this.armed = false;
      await this.firstMayRun; // first caller waits for the second
      await new Promise((r) => setTimeout(r, 5)); // let the second win and start its new session
      return super.revoke(id, at);
    }
    this.secondArrived?.();
    this.secondArrived = null;
    return super.revoke(id, at);
  }
}

describe('concurrent rotation of one session', () => {
  it('same client: both creates succeed, one new session cookie, and the browser stays signed in', async () => {
    const sessions = new OverlappingRevokes();
    const app = await buildApp({ sessions });
    const c = await signupAndLogin(app, 'double@example.com');
    const before = c.jar.get(SID);
    sessions.arm();
    const [a, b] = await Promise.all([
      c.post('/orgs', { name: 'Acme' }),
      c.post('/orgs', { name: 'Beta' }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    const sidCookies = [a, b].flatMap((r) => r.cookies.filter((k) => k.name === SID));
    // Only the winner minted a session; the loser kept it (no Set-Cookie).
    expect(sidCookies).toHaveLength(1);
    expect(c.jar.get(SID)).not.toBe(before);
    expect((await c.get('/auth/session')).statusCode).toBe(200);
    expect(JSON.parse((await c.get('/orgs')).body).items).toHaveLength(2);
    await app.close();
  });

  it('a different client presenting the same session still gets 401', async () => {
    const sessions = new OverlappingRevokes();
    const app = await buildApp({ sessions, sleep: async () => {} });
    const c = await signupAndLogin(app, 'double2@example.com');
    sessions.arm();
    const [a, b] = await Promise.all([
      c.post('/orgs', { name: 'Acme' }),
      c.post('/orgs', { name: 'Beta' }, { 'user-agent': 'some-other-client/1.0' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 401]);
    await app.close();
  });
});
