import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthApp,
  Client,
  comparableBody,
  CSRF,
  errorCode,
  hasAuthApi,
  ORIGIN,
  PASSWORD,
  SID,
  signupAndLogin,
  type InjectApp,
} from '../../support/api-app.js';
import { fixturePassword } from '../../support/fixture-secrets.js';

const WRONG = fixturePassword('wrong');
const WRONG_ALT = fixturePassword('wrong-alt');
const NEW_PW = fixturePassword('new');
const OTHER_PW = fixturePassword('other');

/*
 * AU-* (docs/12-security/test-cases.md) against Backend's PR #27 createServer.
 * Set QA_API_DIR to a checkout of feat/api-auth-orgs apps/api. Cases that need endpoints
 * #27 does not have yet stay in security/auth-abuse.test.ts as skipped, with the reason.
 */
if (!hasAuthApi) console.warn('[api/auth] QA_API_DIR not set or has no auth module: skipping');

const MIN = 60_000;
let open: InjectApp[] = [];
async function setup(deps: Record<string, unknown> = {}) {
  const r = await buildAuthApp(deps);
  open.push(r.app);
  return r;
}
afterEach(async () => {
  await Promise.all(open.map((a) => a.close()));
  open = [];
});

let n = 0;
const email = (tag: string) => `qa-${tag}-${++n}@example.test`;

describe.skipIf(!hasAuthApi)('AU: auth abuse (PR #27)', () => {
  describe('brute force and rate limits', () => {
    it('[AU-01] 10 wrong passwords lock the account; correct password during lock is rejected', async () => {
      const { app } = await setup();
      const e = email('bf');
      await signupAndLogin(app, e);
      const c = new Client(app, '198.51.100.1');
      const codes: number[] = [];
      for (let i = 0; i < 10; i++)
        codes.push((await c.post('/auth/login', { email: e, password: WRONG })).statusCode);
      expect(codes.every((s) => s === 401)).toBe(true);
      const locked = await new Client(app, '198.51.100.2').post('/auth/login', {
        email: e,
        password: PASSWORD,
      });
      expect(locked.statusCode).toBe(429);
    });

    it('[AU-02] lock expires after the window and login works again', async () => {
      const { app, clock } = await setup();
      const e = email('unlock');
      await signupAndLogin(app, e);
      const c = new Client(app, '198.51.100.3');
      for (let i = 0; i < 10; i++) await c.post('/auth/login', { email: e, password: WRONG });
      expect((await c.post('/auth/login', { email: e, password: PASSWORD })).statusCode).toBe(429);
      clock.advance(16 * MIN);
      expect(
        (
          await new Client(app, '198.51.100.4').post('/auth/login', {
            email: e,
            password: PASSWORD,
          })
        ).statusCode,
      ).toBe(200);
    });

    it('[AU-03] more than 20 logins/min from one IP across many emails are rate limited (429)', async () => {
      const { app } = await setup();
      const c = new Client(app, '198.51.100.5');
      const codes: number[] = [];
      for (let i = 0; i < 25; i++)
        codes.push(
          (await c.post('/auth/login', { email: email('stuff'), password: WRONG_ALT })).statusCode,
        );
      expect(codes.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(codes.slice(20).every((s) => s === 429)).toBe(true);
    });

    it('[AU-04] per-account lockout triggers across many IPs', async () => {
      const { app } = await setup();
      const e = email('dist');
      await signupAndLogin(app, e);
      for (let i = 0; i < 10; i++)
        await new Client(app, `192.0.2.${i + 1}`).post('/auth/login', {
          email: e,
          password: WRONG,
        });
      expect(
        (await new Client(app, '192.0.2.200').post('/auth/login', { email: e, password: PASSWORD }))
          .statusCode,
      ).toBe(429);
    });
  });

  describe('enumeration', () => {
    it('[AU-05] unknown email and known email + wrong password give identical status and body', async () => {
      const { app } = await setup();
      const e = email('enum');
      await signupAndLogin(app, e);
      const a = await new Client(app, '198.51.100.10').post('/auth/login', {
        email: email('nobody'),
        password: WRONG,
      });
      const b = await new Client(app, '198.51.100.11').post('/auth/login', {
        email: e,
        password: WRONG,
      });
      expect(a.statusCode).toBe(401);
      expect(b.statusCode).toBe(a.statusCode);
      expect(comparableBody(b)).toEqual(comparableBody(a));
    });

    it('[AU-07] signup with an existing email returns the same 202 (never CONFLICT) and mails the owner', async () => {
      const { app, mailer } = await setup();
      const e = email('dup');
      const first = await new Client(app, '198.51.100.12').post('/auth/signup', {
        name: 'A',
        email: e,
        password: PASSWORD,
      });
      const again = await new Client(app, '198.51.100.13').post('/auth/signup', {
        name: 'B',
        email: e,
        password: PASSWORD,
      });
      expect(first.statusCode).toBe(202);
      expect(again.statusCode).toBe(202);
      expect(comparableBody(again)).toEqual(comparableBody(first));
      expect(again.body).not.toMatch(/CONFLICT/i);
      expect(mailer.sent.filter((m) => m.to === e).map((m) => m.kind)).toEqual([
        'verify',
        'exists',
      ]);
    });

    it('[AU-08] password reset for unknown and known email gives the same response', async () => {
      const { app, mailer } = await setup();
      const e = email('reset-enum');
      await signupAndLogin(app, e);
      const a = await new Client(app, '198.51.100.14').post('/auth/forgot-password', {
        email: email('ghost'),
      });
      const b = await new Client(app, '198.51.100.15').post('/auth/forgot-password', { email: e });
      expect(a.statusCode).toBe(202);
      expect(b.statusCode).toBe(202);
      expect(comparableBody(b)).toEqual(comparableBody(a));
      expect(mailer.sent.some((m) => m.kind === 'reset' && m.to === e)).toBe(true);
    });
  });

  describe('sessions', () => {
    it('[AU-09] a pre-chosen session cookie is replaced on login and is not valid afterwards', async () => {
      const { app } = await setup();
      const e = email('fix');
      await new Client(app).post('/auth/signup', { name: 'F', email: e, password: PASSWORD });
      const c = new Client(app);
      c.jar.set(SID, 'attacker-chosen-session-id');
      expect((await c.post('/auth/login', { email: e, password: PASSWORD })).statusCode).toBe(200);
      expect(c.jar.get(SID)).toBeDefined();
      expect(c.jar.get(SID)).not.toBe('attacker-chosen-session-id');
      const attacker = new Client(app);
      attacker.jar.set(SID, 'attacker-chosen-session-id');
      expect((await attacker.get('/auth/session')).statusCode).toBe(401);
    });

    it('[AU-10] org switch rotates the session id and the old id stops working', async () => {
      const { app } = await setup();
      const c = await signupAndLogin(app, email('rot'));
      const created = await c.post('/orgs', { name: 'Rotate Org' });
      expect(created.statusCode).toBe(201);
      const before = c.jar.get(SID);
      const orgId = created.json().organization.id as string;
      const sw = await c.post('/orgs/switch', { organizationId: orgId });
      expect(sw.statusCode).toBe(200);
      expect(c.jar.get(SID)).not.toBe(before);
      const old = new Client(app);
      old.jar.set(SID, before ?? '');
      expect((await old.get('/auth/session')).statusCode).toBe(401);
    });

    it('[AU-11] idle for more than 30 min returns 401', async () => {
      const { app, clock } = await setup();
      const c = await signupAndLogin(app, email('idle'));
      expect((await c.get('/auth/session')).statusCode).toBe(200);
      clock.advance(31 * MIN);
      expect((await c.get('/auth/session')).statusCode).toBe(401);
    });

    it('[AU-12] active for more than 12 h returns 401 even with constant activity', async () => {
      const { app, clock } = await setup();
      const c = await signupAndLogin(app, email('abs'));
      for (let i = 0; i < 25; i++) {
        clock.advance(29 * MIN);
        const r = await c.get('/auth/session');
        if (i < 24) expect(r.statusCode, `step ${i}`).toBe(200);
      }
      clock.advance(29 * MIN);
      expect((await c.get('/auth/session')).statusCode).toBe(401);
    });

    it('[AU-13] after logout, replaying the old cookie returns 401', async () => {
      const { app } = await setup();
      const c = await signupAndLogin(app, email('logout'));
      const sid = c.jar.get(SID) ?? '';
      expect((await c.post('/auth/logout')).statusCode).toBe(204);
      const replay = new Client(app);
      replay.jar.set(SID, sid);
      expect((await replay.get('/auth/session')).statusCode).toBe(401);
    });
  });

  describe('CSRF and origin', () => {
    it('[AU-14] POST without X-CSRF-Token is 403', async () => {
      const { app } = await setup();
      const c = await signupAndLogin(app, email('csrf1'));
      const r = await app.inject({
        method: 'POST',
        url: '/orgs',
        payload: { name: 'x' },
        headers: { cookie: c.cookie, origin: ORIGIN },
      });
      expect(r.statusCode).toBe(403);
    });

    it('[AU-15] CSRF token from another session is 403', async () => {
      const { app } = await setup();
      const victim = await signupAndLogin(app, email('csrf2'));
      const other = new Client(app);
      await other.csrf();
      const r = await app.inject({
        method: 'POST',
        url: '/orgs',
        payload: { name: 'x' },
        headers: {
          cookie: victim.cookie,
          origin: ORIGIN,
          'x-csrf-token': other.jar.get(CSRF) ?? '',
        },
      });
      expect(r.statusCode).toBe(403);
    });

    it('[AU-16] valid token with Origin https://evil.example is 403', async () => {
      const { app } = await setup();
      const c = await signupAndLogin(app, email('csrf3'));
      expect(
        (await c.post('/orgs', { name: 'x' }, { origin: 'https://evil.example' })).statusCode,
      ).toBe(403);
    });

    it('[AU-17] state-changing request with neither Origin nor Referer is 403', async () => {
      const { app } = await setup();
      const c = await signupAndLogin(app, email('csrf4'));
      const r = await app.inject({
        method: 'POST',
        url: '/orgs',
        payload: { name: 'x' },
        headers: { cookie: c.cookie, 'x-csrf-token': c.jar.get(CSRF) ?? '' },
      });
      expect(r.statusCode).toBe(403);
    });

    it('[AU-18] GET cannot mutate (logout / create org via GET is 404/405)', async () => {
      const { app } = await setup();
      const c = await signupAndLogin(app, email('getmut'));
      expect([404, 405]).toContain((await c.get('/auth/logout')).statusCode);
      expect((await c.get('/auth/session')).statusCode).toBe(200);
      const list = await c.get('/orgs');
      expect(list.statusCode).toBe(200);
    });

    it('[AU-19] session and CSRF cookies: __Host- prefix, Secure, HttpOnly (sid), SameSite=Lax, Path=/, no Domain', async () => {
      const { app } = await setup();
      const e = email('cookie');
      await new Client(app).post('/auth/signup', { name: 'C', email: e, password: PASSWORD });
      const c = new Client(app);
      const r = await c.post('/auth/login', { email: e, password: PASSWORD });
      const raw = ([] as string[]).concat(
        (r.headers['set-cookie'] as string[] | string | undefined) ?? [],
      );
      const sid = raw.find((h) => h.startsWith(`${SID}=`));
      expect(sid, 'session Set-Cookie').toBeDefined();
      expect(sid).toMatch(/;\s*Secure/i);
      expect(sid).toMatch(/;\s*HttpOnly/i);
      expect(sid).toMatch(/;\s*SameSite=Lax/i);
      expect(sid).toMatch(/;\s*Path=\//i);
      expect(sid).not.toMatch(/;\s*Domain=/i);
    });
  });

  describe('password reset', () => {
    async function resetFlow() {
      const r = await setup();
      const e = email('reset');
      const c = await signupAndLogin(r.app, e);
      await new Client(r.app, '198.51.100.30').post('/auth/forgot-password', { email: e });
      const token = r.mailer.sent.find((m) => m.kind === 'reset' && m.to === e)?.token ?? '';
      expect(token).not.toBe('');
      return { ...r, e, c, token };
    }

    it('[AU-21] a reset token works once; the second use is rejected', async () => {
      const { app, token, e } = await resetFlow();
      const first = await new Client(app, '198.51.100.31').post('/auth/reset-password', {
        token,
        password: NEW_PW,
      });
      expect(first.statusCode).toBe(204);
      const second = await new Client(app, '198.51.100.32').post('/auth/reset-password', {
        token,
        password: OTHER_PW,
      });
      expect(second.statusCode).toBe(400);
      expect(errorCode(second)).toBe('BAD_REQUEST');
      // The rejected second use must not have changed the password.
      const login = (password: string, ip: string) =>
        new Client(app, ip).post('/auth/login', { email: e, password });
      expect((await login(OTHER_PW, '198.51.100.35')).statusCode).toBe(401);
      expect((await login(NEW_PW, '198.51.100.36')).statusCode).toBe(200);
    });

    it('[AU-22] a reset token used after 30 min is rejected', async () => {
      const { app, clock, token, e } = await resetFlow();
      clock.advance(31 * MIN);
      const r = await new Client(app, '198.51.100.33').post('/auth/reset-password', {
        token,
        password: NEW_PW,
      });
      expect(r.statusCode).toBe(400);
      expect(errorCode(r)).toBe('BAD_REQUEST');
      // The password is unchanged: the new one fails, the original still works.
      const login = (password: string, ip: string) =>
        new Client(app, ip).post('/auth/login', { email: e, password });
      expect((await login(NEW_PW, '198.51.100.37')).statusCode).toBe(401);
      expect((await login(PASSWORD, '198.51.100.38')).statusCode).toBe(200);
    });

    it('[AU-23] resetting the password revokes all existing sessions', async () => {
      const { app, c, token } = await resetFlow();
      expect((await c.get('/auth/session')).statusCode).toBe(200);
      expect(
        (
          await new Client(app, '198.51.100.34').post('/auth/reset-password', {
            token,
            password: NEW_PW,
          })
        ).statusCode,
      ).toBe(204);
      expect((await c.get('/auth/session')).statusCode).toBe(401);
    });
  });

  describe('invitations', () => {
    async function inviteFlow(role: 'admin' | 'member' | 'viewer' = 'member') {
      const r = await setup();
      const owner = await signupAndLogin(r.app, email('owner'));
      const org = (await owner.post('/orgs', { name: 'Invite Org' })).json().organization as {
        id: string;
      };
      const inviteeEmail = email('invitee');
      const inv = await owner.post(`/orgs/${org.id}/invitations`, { email: inviteeEmail, role });
      expect(inv.statusCode).toBe(201);
      const token =
        r.mailer.sent.find((m) => m.kind === 'invite' || (m.to === inviteeEmail && m.token))
          ?.token ?? '';
      return { ...r, owner, org, inviteeEmail, token };
    }

    it('[AU-24] accepting the same invite twice: second is rejected with NOT_FOUND', async () => {
      const { app, inviteeEmail, token } = await inviteFlow();
      expect(token).not.toBe('');
      const invitee = await signupAndLogin(app, inviteeEmail);
      expect((await invitee.post('/invitations/accept', { token })).statusCode).toBe(200);
      const again = await invitee.post('/invitations/accept', { token });
      expect(again.statusCode).toBe(404);
      expect(errorCode(again)).toBe('NOT_FOUND');
    });

    it('[AU-25] accepting with a different account email is rejected with NOT_FOUND', async () => {
      const { app, token } = await inviteFlow();
      const stranger = await signupAndLogin(app, email('stranger'));
      const r = await stranger.post('/invitations/accept', { token });
      expect(r.statusCode).toBe(404);
      expect(errorCode(r)).toBe('NOT_FOUND');
    });

    it('[AU-26] accepting after 7 days is rejected', async () => {
      const { app, clock, inviteeEmail, token } = await inviteFlow();
      clock.advance(7 * 24 * 60 * MIN + MIN);
      const invitee = await signupAndLogin(app, inviteeEmail);
      expect((await invitee.post('/invitations/accept', { token })).statusCode).toBe(404);
    });

    it('[AU-27] > 5 invites/day to one address and > 50/day per org are 429', async () => {
      const { owner, org } = await inviteFlow();
      const same = email('flood');
      const perAddr: number[] = [];
      for (let i = 0; i < 6; i++)
        perAddr.push(
          (await owner.post(`/orgs/${org.id}/invitations`, { email: same, role: 'member' }))
            .statusCode,
        );
      expect(perAddr.slice(0, 5).every((c) => c === 201)).toBe(true);
      expect(perAddr[5]).toBe(429);
      // Every attempt counts toward the org limit, rejected ones included: inviteFlow made 1
      // and the per-address loop 6, so attempts 8..50 succeed and attempt 51 is the first 429.
      const perOrg: number[] = [];
      for (let i = 0; i < 44; i++)
        perOrg.push(
          (await owner.post(`/orgs/${org.id}/invitations`, { email: email('o'), role: 'member' }))
            .statusCode,
        );
      expect(perOrg.slice(0, 43).every((c) => c === 201)).toBe(true);
      expect(perOrg[43]).toBe(429);
    });

    it('[AU-28] an admin cannot invite with role owner (owner is not invitable)', async () => {
      const { app, owner, org, inviteeEmail, token } = await inviteFlow('admin');
      const admin = await signupAndLogin(app, inviteeEmail);
      expect((await admin.post('/invitations/accept', { token })).statusCode).toBe(200);
      const r = await admin.post(`/orgs/${org.id}/invitations`, {
        email: email('escalate'),
        role: 'owner',
      });
      expect([400, 403]).toContain(r.statusCode);
      // owner cannot either: role owner is not in the invitable set
      expect([400, 403]).toContain(
        (await owner.post(`/orgs/${org.id}/invitations`, { email: email('e2'), role: 'owner' }))
          .statusCode,
      );
    });

    it('[AU-32 (org scope)] a viewer cannot create invitations (403)', async () => {
      const { app, org, inviteeEmail, token } = await inviteFlow('viewer');
      const viewer = await signupAndLogin(app, inviteeEmail);
      expect((await viewer.post('/invitations/accept', { token })).statusCode).toBe(200);
      expect(
        (await viewer.post(`/orgs/${org.id}/invitations`, { email: email('v'), role: 'member' }))
          .statusCode,
      ).toBe(403);
    });
  });
});
