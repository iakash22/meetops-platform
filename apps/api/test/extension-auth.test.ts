import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import { InMemoryExtensionTokenRepository } from '../src/modules/extension-auth/index.js';
import { buildApp, signupAndLogin, SID, type App } from './helpers.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;
const nonce = () => createHash('sha256').update(randomUUID()).digest('base64url');
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

async function setup() {
  const extensionTokens = new InMemoryExtensionTokenRepository();
  const app = await buildApp({ extensionTokens, extensionIds: [EXT] });
  const email = `ext-${randomUUID()}@example.com`;
  const c = await signupAndLogin(app, email);
  const org = await c.post('/orgs', { name: 'Ext Org' });
  expect(org.statusCode).toBe(201);
  return { app, c, extensionTokens };
}

const ext = (app: App, url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: EXT_ORIGIN, ...headers } });

async function paired(app: App, c: Awaited<ReturnType<typeof setup>>['c']) {
  const deviceId = randomUUID();
  const n = nonce();
  const pair = await c.post(EXTENSION_AUTH_PATHS.pair, { extensionId: EXT, deviceId, nonce: n });
  expect(pair.statusCode).toBe(200);
  const { pairingCode } = pair.json<{ pairingCode: string }>();
  return { deviceId, n, pairingCode };
}

describe('extension auth (ADR-005 A1)', () => {
  it('pairs, exchanges, rotates, and revokes the family on refresh reuse', async () => {
    const { app, c, extensionTokens } = await setup();
    const { deviceId, n, pairingCode } = await paired(app, c);
    const tok = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: n,
    });
    expect(tok.statusCode).toBe(200);
    expect(tok.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
    expect(tok.headers['access-control-allow-credentials']).toBeUndefined();
    const t1 = tok.json<{ accessToken: string; refreshToken: string }>();
    // Only hashes are stored.
    expect(await extensionTokens.findAccess(sha(t1.accessToken))).not.toBeNull();
    expect(JSON.stringify(extensionTokens)).not.toContain(t1.accessToken);

    // Pairing code is single-use.
    const again = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: n,
    });
    expect(again.statusCode).toBe(401);

    const r1 = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(r1.statusCode).toBe(200);
    const t2 = r1.json<{ accessToken: string; refreshToken: string }>();
    expect(t2.refreshToken).not.toBe(t1.refreshToken);

    const reuse = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(reuse.statusCode).toBe(401);
    const after = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t2.refreshToken,
    });
    expect(after.statusCode).toBe(401);
    const a2 = await extensionTokens.findAccess(sha(t2.accessToken));
    expect(a2 && (await extensionTokens.findFamily(a2.familyId))?.revokedAt).toBeTruthy();
  });

  it('rejects a nonce mismatch and a non-allowlisted extension', async () => {
    const { app, c } = await setup();
    const { deviceId, pairingCode } = await paired(app, c);
    const bad = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: nonce(),
    });
    expect(bad.statusCode).toBe(401);
    const other = await c.post(EXTENSION_AUTH_PATHS.pair, {
      extensionId: 'ponmlkjihgfedcbaponmlkjihgfedcba',
      deviceId: randomUUID(),
      nonce: nonce(),
    });
    expect(other.statusCode).toBe(403);
  });

  it('rejects the session cookie on extension routes and gives no CORS to other origins', async () => {
    const { app, c } = await setup();
    const withCookie = await ext(
      app,
      EXTENSION_AUTH_PATHS.refresh,
      { extensionId: EXT, deviceId: randomUUID(), refreshToken: 'x'.repeat(43) },
      { cookie: `${SID}=${c.jar.get(SID)}` },
    );
    expect(withCookie.statusCode).toBe(401);
    const pre = await app.inject({
      method: 'OPTIONS',
      url: EXTENSION_AUTH_PATHS.token,
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('requires a session + CSRF to pair', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: EXTENSION_AUTH_PATHS.pair,
      payload: { extensionId: EXT, deviceId: randomUUID(), nonce: nonce() },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('revoke is idempotent and logout revokes the user families', async () => {
    const { app, c } = await setup();
    const p = await paired(app, c);
    const t = (
      await ext(app, EXTENSION_AUTH_PATHS.token, {
        extensionId: EXT,
        deviceId: p.deviceId,
        pairingCode: p.pairingCode,
        nonce: p.n,
      })
    ).json<{ refreshToken: string }>();
    expect(
      (
        await ext(app, EXTENSION_AUTH_PATHS.revoke, {
          extensionId: EXT,
          deviceId: p.deviceId,
          refreshToken: t.refreshToken,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ext(app, EXTENSION_AUTH_PATHS.revoke, {
          extensionId: EXT,
          deviceId: p.deviceId,
          refreshToken: t.refreshToken,
        })
      ).statusCode,
    ).toBe(200);

    const q = await paired(app, c);
    const u = (
      await ext(app, EXTENSION_AUTH_PATHS.token, {
        extensionId: EXT,
        deviceId: q.deviceId,
        pairingCode: q.pairingCode,
        nonce: q.n,
      })
    ).json<{ refreshToken: string }>();
    expect((await c.post('/auth/logout')).statusCode).toBeLessThan(300);
    expect(
      (
        await ext(app, EXTENSION_AUTH_PATHS.refresh, {
          extensionId: EXT,
          deviceId: q.deviceId,
          refreshToken: u.refreshToken,
        })
      ).statusCode,
    ).toBe(401);
  });
});
