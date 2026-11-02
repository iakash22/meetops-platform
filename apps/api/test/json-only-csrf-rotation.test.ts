import { afterEach, describe, expect, it } from 'vitest';
import { baseMediaType } from '../src/shared/json-only.js';
import { buildApp, Client, CSRF, ORIGIN, PASSWORD, signupAndLogin, type App } from './helpers.js';

let app: App;
afterEach(async () => app?.close());

/** Raw unsafe request with the client's cookies, Origin and CSRF header but a chosen body/content type. */
async function raw(c: Client, url: string, payload: string | undefined, type: string | undefined) {
  if (!c.jar.has(CSRF)) await c.csrf();
  return app.inject({
    method: 'POST',
    url,
    ...(payload !== undefined ? { payload } : {}),
    headers: {
      cookie: c.cookie,
      origin: ORIGIN,
      'x-csrf-token': c.jar.get(CSRF)!,
      ...(type ? { 'content-type': type } : {}),
    },
  });
}

describe('P9 R16: unsafe requests with a body must be JSON', () => {
  it.each([
    ['text/plain', 'x'],
    ['application/x-www-form-urlencoded', 'a=b'],
    ['multipart/form-data; boundary=x', '--x--'],
    ['application/xml', '<a/>'],
  ])('415 for %s on a JSON route', async (type, payload) => {
    app = await buildApp();
    const c = await signupAndLogin(app, 'r16a@example.com');
    const res = await raw(c, '/orgs', payload, type);
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBeTypeOf('string');
  });

  it('accepts application/json with parameters and empty-body mutations', async () => {
    app = await buildApp();
    const c = await signupAndLogin(app, 'r16b@example.com');
    const json = await raw(
      c,
      '/orgs',
      JSON.stringify({ name: 'R16' }),
      'Application/JSON; charset=utf-8',
    );
    expect(json.statusCode).toBe(201);
    // Org create rotates the session (and CSRF token), so use a fresh login for the empty-body case.
    const d = await signupAndLogin(app, 'r16b2@example.com');
    const empty = await raw(d, '/auth/logout', undefined, undefined);
    expect(empty.statusCode).toBe(204);
  });

  it('webhooks stay JSON-only', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github/00000000-0000-4000-8000-000000000001',
      payload: 'a=b',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(415);
  });

  it('RFC 8058 one-click unsubscribe (form POST) is allowlisted', async () => {
    app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/notifications/unsubscribe?token=forged',
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).not.toBe(415);
  });

  it('baseMediaType normalises parameters and case', () => {
    expect(baseMediaType(' Text/Plain ;charset=utf-8')).toBe('text/plain');
    expect(baseMediaType(undefined)).toBe('');
  });
});

describe('P9 R17: the CSRF token rotates on login, org switch and logout', () => {
  const write = (c: Client, token: string) =>
    app.inject({
      method: 'POST',
      url: '/orgs',
      payload: { name: 'probe' },
      headers: {
        cookie: `${c.cookie.replace(/(__Host-meetops_csrf=)[^;]*/, `$1${token}`)}`,
        origin: ORIGIN,
        'x-csrf-token': token,
      },
    });

  it('a pre-login token is rejected after login, and login retires the pre-session cookie', async () => {
    app = await buildApp();
    await signupAndLogin(app, 'r17a@example.com');
    const c = new Client(app);
    const pre = await c.csrf();
    const login = await c.post('/auth/login', { email: 'r17a@example.com', password: PASSWORD });
    expect(login.statusCode).toBe(200);
    expect(login.json().csrfToken).not.toBe(pre);
    expect(c.jar.has('__Host-meetops_presession')).toBe(false);
    expect((await write(c, pre)).statusCode).toBe(403);
    expect((await write(c, login.json().csrfToken)).statusCode).toBe(201);
  });

  it('the old token is rejected after an org switch', async () => {
    app = await buildApp();
    const c = await signupAndLogin(app, 'r17b@example.com');
    const id = (await c.post('/orgs', { name: 'B' })).json<{ organization: { id: string } }>()
      .organization.id;
    const before = c.jar.get(CSRF)!;
    const sw = await c.post('/orgs/switch', { organizationId: id });
    expect(sw.statusCode).toBe(200);
    const after = c.jar.get(CSRF)!;
    expect(after).not.toBe(before);
    expect((await write(c, before)).statusCode).toBe(403);
    expect((await write(c, after)).statusCode).toBe(201);
  });

  it('the old token is rejected after logout', async () => {
    app = await buildApp();
    const c = await signupAndLogin(app, 'r17c@example.com');
    const before = c.jar.get(CSRF)!;
    expect((await c.post('/auth/logout')).statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/forgot-password',
      payload: { email: 'r17c@example.com' },
      headers: { cookie: `${CSRF}=${before}`, origin: ORIGIN, 'x-csrf-token': before },
    });
    expect(res.statusCode).toBe(403);
  });
});
