import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

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

    // Past the ~10 s grace window, so re-presenting the old token is reuse.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11_000 });
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

describe('extension refresh grace window', () => {
  async function rotated() {
    const { app, c, extensionTokens } = await setup();
    const { deviceId, n, pairingCode } = await paired(app, c);
    const tok = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: n,
    });
    const t1 = tok.json<{ accessToken: string; refreshToken: string }>();
    const r1 = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(r1.statusCode).toBe(200);
    return {
      app,
      extensionTokens,
      deviceId,
      t1,
      t2: r1.json<{ accessToken: string; refreshToken: string }>(),
    };
  }

  it('returns the same new pair when the same device re-sends the previous token within ~10 s', async () => {
    const { app, deviceId, t1, t2 } = await rotated();
    const again = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      accessToken: t2.accessToken,
      refreshToken: t2.refreshToken,
    });
    // The family is intact: the new refresh token still rotates.
    const next = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t2.refreshToken,
    });
    expect(next.statusCode).toBe(200);
  });

  it('still revokes the family when another device re-sends the token within the window', async () => {
    const { app, extensionTokens, t1, t2 } = await rotated();
    const other = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId: randomUUID(),
      refreshToken: t1.refreshToken,
    });
    expect(other.statusCode).toBe(401);
    const a2 = await extensionTokens.findAccess(sha(t2.accessToken));
    expect(a2 && (await extensionTokens.findFamily(a2.familyId))?.revokedAt).toBeTruthy();
  });

  it('does not extend grace to a token older than the immediately previous one', async () => {
    const { app, deviceId, t1, t2 } = await rotated();
    const r2 = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t2.refreshToken,
    });
    expect(r2.statusCode).toBe(200);
    const old = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(old.statusCode).toBe(401);
  });
});

describe('extension refresh grace window vs allowlist revoke (#418)', () => {
  it('rejects a delisted extension replaying its previous token within the grace window', async () => {
    // Mutable allowlist shared with the running service, so it can be delisted mid-window.
    const extensionIds: string[] = [EXT];
    const extensionTokens = new InMemoryExtensionTokenRepository();
    const app = await buildApp({ extensionTokens, extensionIds });
    const c = await signupAndLogin(app, `ext-${randomUUID()}@example.com`);
    expect((await c.post('/orgs', { name: 'Ext Org' })).statusCode).toBe(201);
    const { deviceId, n, pairingCode } = await paired(app, c);
    const tok = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: n,
    });
    const t1 = tok.json<{ accessToken: string; refreshToken: string }>();
    const r1 = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(r1.statusCode).toBe(200);
    const t2 = r1.json<{ accessToken: string; refreshToken: string }>();

    // The extension id is removed from the allowlist (another id stays, so this is a real delisting, not the
    // empty-allowlist misconfiguration); the same device replays t1 inside ~10 s.
    extensionIds.splice(0, extensionIds.length, 'q'.repeat(32));
    const replay = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
      extensionId: EXT,
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(replay.statusCode).not.toBe(200);
    expect(replay.body).not.toContain(t2.refreshToken);
    const a2 = await extensionTokens.findAccess(sha(t2.accessToken));
    expect(a2 && (await extensionTokens.findFamily(a2.familyId))?.revokedAt).toBeTruthy();
  });
});
