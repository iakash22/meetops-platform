import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import { createSessionVerifier } from '@meetops/session-verifier';
import {
  ExtensionAuthService,
  InMemoryExtensionTokenRepository,
  RedisExtensionTokenRepository,
  type ExtensionTokenRepository,
} from '../src/modules/extension-auth/index.js';
import type { ExtensionAuthDeps } from '../src/modules/extension-auth/application/extension-auth.service.js';
import type { TokenFamily } from '../src/modules/extension-auth/domain/extension-token.js';
import { buildApp, signupAndLogin, type App } from './helpers.js';
import { fakeRedis } from './fake-redis.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;
const nonce = () => createHash('sha256').update(randomUUID()).digest('base64url');

const ext = (app: App, url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: EXT_ORIGIN } });

/** The shared ADR-011 verifier over the service's store; membership is always live here. */
function bearerVerifier(
  extensionTokens: ExtensionTokenRepository,
  now = () => new Date(),
  extensionIds: readonly string[] = [EXT],
) {
  const svc = new ExtensionAuthService({
    extensionTokens,
    extensionIds,
    clock: { now },
  } as unknown as ExtensionAuthDeps);
  return createSessionVerifier({
    sessions: {
      findSessionByTokenHash: () => Promise.resolve(null),
      findMembership: () => Promise.resolve({ role: 'member', deletedAt: null }),
    },
    clock: { now },
    idleTimeoutMs: 60_000,
    extensionTokens: svc.verifierStore(),
  });
}

async function pairedToken() {
  const extensionTokens = new InMemoryExtensionTokenRepository();
  const app = await buildApp({ extensionTokens, extensionIds: [EXT] });
  const c = await signupAndLogin(app, `rev-${randomUUID()}@example.com`);
  expect((await c.post('/orgs', { name: 'Rev Org' })).statusCode).toBe(201);
  const deviceId = randomUUID();
  const n = nonce();
  const pair = await c.post(EXTENSION_AUTH_PATHS.pair, { extensionId: EXT, deviceId, nonce: n });
  const { pairingCode } = pair.json<{ pairingCode: string }>();
  const tok = await ext(app, EXTENSION_AUTH_PATHS.token, {
    extensionId: EXT,
    deviceId,
    pairingCode,
    nonce: n,
  });
  expect(tok.statusCode).toBe(200);
  const t = tok.json<{ accessToken: string; refreshToken: string }>();
  return { app, c, extensionTokens, deviceId, ...t };
}

describe('extension access token revocation is immediate (security finding M1)', () => {
  it('rejects a still-unexpired access token right after POST /auth/extension/revoke', async () => {
    const { app, extensionTokens, deviceId, accessToken, refreshToken } = await pairedToken();
    const v = bearerVerifier(extensionTokens);
    expect(await v.verifySession({ bearer: accessToken })).not.toBeNull();
    const r = await ext(app, EXTENSION_AUTH_PATHS.revoke, {
      extensionId: EXT,
      deviceId,
      refreshToken,
    });
    expect(r.statusCode).toBe(200);
    expect(await v.verifySession({ bearer: accessToken })).toBeNull();
  });

  it('rejects the access token right after the web session logs out', async () => {
    const { c, extensionTokens, accessToken } = await pairedToken();
    const v = bearerVerifier(extensionTokens);
    expect(await v.verifySession({ bearer: accessToken })).not.toBeNull();
    expect((await c.post('/auth/logout')).statusCode).toBeLessThan(300);
    expect(await v.verifySession({ bearer: accessToken })).toBeNull();
  });

  it('fails closed when the family lookup errors or does not match the token', async () => {
    const { extensionTokens, accessToken } = await pairedToken();
    const broken = Object.create(extensionTokens) as ExtensionTokenRepository;
    broken.findFamily = () => Promise.reject(new Error('postgres down'));
    expect(await bearerVerifier(broken).verifySession({ bearer: accessToken })).toBeNull();

    const other = Object.create(extensionTokens) as ExtensionTokenRepository;
    other.findFamily = async (id) => {
      const f = await extensionTokens.findFamily(id);
      return f && { ...f, userId: randomUUID() };
    };
    expect(await bearerVerifier(other).verifySession({ bearer: accessToken })).toBeNull();
  });

  it('rejects once the family passes its absolute lifetime, even with a live access token', async () => {
    const { extensionTokens, accessToken } = await pairedToken();
    const later = () => new Date(Date.now() + 400 * 24 * 3600 * 1000);
    expect(
      await bearerVerifier(extensionTokens, later).verifySession({ bearer: accessToken }),
    ).toBeNull();
  });
});

describe('Redis revocation marker', () => {
  const fam = (): TokenFamily => ({
    id: randomUUID(),
    userId: randomUUID(),
    organizationId: randomUUID(),
    extensionId: EXT,
    deviceId: randomUUID(),
    deviceLabel: null,
    scopes: [],
    createdAt: new Date(),
    maxExpiresAt: new Date(Date.now() + 3600_000),
    revokedAt: null,
  });

  it('keeps a family revoked even if its record is rewritten without revokedAt', async () => {
    const redis = fakeRedis();
    const repo = new RedisExtensionTokenRepository(redis);
    const f = fam();
    await repo.createFamily(f);
    const at = new Date('2026-10-27T00:00:00Z');
    await repo.revokeFamily(f.id, at);
    // Simulate a racing writer that saved the stale, unrevoked record after the revoke.
    await repo.createFamily(f);
    expect((await repo.findFamily(f.id))?.revokedAt).toEqual(at);
    expect(await repo.listFamilies(f.userId, new Date())).toEqual([]);
  });
});

describe('extension allowlist is enforced after pairing', () => {
  it('rejects access tokens of an extension id removed from the allowlist', async () => {
    const { extensionTokens, accessToken } = await pairedToken();
    expect(
      await bearerVerifier(extensionTokens).verifySession({ bearer: accessToken }),
    ).not.toBeNull();
    const delisted = bearerVerifier(extensionTokens, () => new Date(), ['p'.repeat(32)]);
    expect(await delisted.verifySession({ bearer: accessToken })).toBeNull();
  });

  it('refuses refresh and revokes the family once the extension id is delisted', async () => {
    const { extensionTokens, deviceId, accessToken, refreshToken } = await pairedToken();
    const app = await buildApp({ extensionTokens, extensionIds: ['p'.repeat(32)] });
    const r = await app.inject({
      method: 'POST',
      url: EXTENSION_AUTH_PATHS.refresh,
      payload: { extensionId: EXT, deviceId, refreshToken },
      headers: { origin: EXT_ORIGIN },
    });
    expect(r.statusCode).toBe(401);
    // The family is revoked, so even with EXT allowlisted again the access token is dead.
    expect(await bearerVerifier(extensionTokens).verifySession({ bearer: accessToken })).toBeNull();
  });

  it('writes an extension.token.delisted audit event when delisting revokes the family', async () => {
    const { extensionTokens, deviceId, refreshToken } = await pairedToken();
    const audit = new InMemoryAuditLog();
    const app = await buildApp({ extensionTokens, extensionIds: ['p'.repeat(32)], audit });
    const r = await app.inject({
      method: 'POST',
      url: EXTENSION_AUTH_PATHS.refresh,
      payload: { extensionId: EXT, deviceId, refreshToken },
      headers: { origin: EXT_ORIGIN },
    });
    expect(r.statusCode).toBe(401);
    const ev = audit.events.filter((e) => e.action === 'extension.token.delisted');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ targetType: 'extension_device', targetId: deviceId });
    expect(ev[0]!.metadata).toMatchObject({ extensionId: EXT });
  });

  it('an EMPTY allowlist (misconfigured deploy) refuses refresh but does not revoke the family', async () => {
    const { extensionTokens, deviceId, accessToken, refreshToken } = await pairedToken();
    const audit = new InMemoryAuditLog();
    const misconfigured = await buildApp({ extensionTokens, extensionIds: [], audit });
    const r = await misconfigured.inject({
      method: 'POST',
      url: EXTENSION_AUTH_PATHS.refresh,
      payload: { extensionId: EXT, deviceId, refreshToken },
      headers: { origin: EXT_ORIGIN },
    });
    expect(r.statusCode).toBe(401);
    expect(audit.events.some((e) => e.action === 'extension.token.delisted')).toBe(false);
    // Config fixed: the family was left intact, so the access token still verifies.
    expect(
      await bearerVerifier(extensionTokens).verifySession({ bearer: accessToken }),
    ).not.toBeNull();
  });
  it('misconfigured refresh does not burn the token: after the config is fixed the SAME token rotates (no reuse, no revoke)', async () => {
    // One app whose allowlist array is flipped in place: empty (misconfigured deploy), then restored.
    const extensionTokens = new InMemoryExtensionTokenRepository();
    const audit = new InMemoryAuditLog();
    const extensionIds: string[] = [EXT];
    const app = await buildApp({ extensionTokens, extensionIds, audit });
    const c = await signupAndLogin(app, `mis-${randomUUID()}@example.com`);
    expect((await c.post('/orgs', { name: 'Mis Org' })).statusCode).toBe(201);
    const deviceId = randomUUID();
    const n = nonce();
    const { pairingCode } = (
      await c.post(EXTENSION_AUTH_PATHS.pair, { extensionId: EXT, deviceId, nonce: n })
    ).json<{ pairingCode: string }>();
    const tok = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: n,
    });
    expect(tok.statusCode).toBe(200);
    const { accessToken, refreshToken } = tok.json<{ accessToken: string; refreshToken: string }>();
    const payload = { extensionId: EXT, deviceId, refreshToken };

    extensionIds.length = 0;
    const bad = await ext(app, EXTENSION_AUTH_PATHS.refresh, payload);
    expect(bad.statusCode).toBe(401);
    expect(
      await bearerVerifier(extensionTokens).verifySession({ bearer: accessToken }),
    ).not.toBeNull();

    extensionIds.push(EXT);
    const ok = await ext(app, EXTENSION_AUTH_PATHS.refresh, payload);
    expect(ok.statusCode).toBe(200);
    const pair = ok.json<{ accessToken: string; refreshToken: string }>();
    expect(pair.refreshToken).not.toBe(refreshToken);
    expect(
      audit.events.filter((e) =>
        [
          'extension.token.reuse_detected',
          'extension.token.delisted',
          'extension.token.revoke',
        ].includes(e.action),
      ),
    ).toEqual([]);
    expect(audit.events.filter((e) => e.action === 'extension.token.refresh')).toHaveLength(1);
    // Family intact: the rotated access token verifies.
    expect(
      await bearerVerifier(extensionTokens).verifySession({ bearer: pair.accessToken }),
    ).not.toBeNull();
    await app.close();
  });
});
