import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DESKTOP_AUTH_PATHS, DESKTOP_SCOPES } from '@meetops/contracts';
import { createSessionVerifier } from '@meetops/session-verifier';
import { InMemoryExtensionTokenRepository } from '../src/modules/extension-auth/index.js';
import { DesktopAuthService, pkceS256Matches } from '../src/modules/desktop-auth/index.js';
import type { DesktopAuthDeps } from '../src/modules/desktop-auth/application/desktop-auth.service.js';
import { buildApp, signupAndLogin, type App } from './helpers.js';

const REDIRECT = 'http://127.0.0.1:53682/callback';
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

type Tokens = {
  accessToken: string;
  refreshToken: string;
  organizationId: string;
  scopes: string[];
};

async function setup(enabled = true) {
  const desktopTokens = new InMemoryExtensionTokenRepository();
  const app = await buildApp({ desktopTokens, ...(enabled ? { desktopAuthEnabled: true } : {}) });
  const c = await signupAndLogin(app, `desk-${randomUUID()}@example.com`);
  const org = await c.post('/orgs', { name: 'Desk Org' });
  expect(org.statusCode).toBe(201);
  return {
    app,
    c,
    desktopTokens,
    orgId: org.json<{ organization: { id: string } }>().organization.id,
  };
}

const post = (app: App, url: string, payload: object, remoteAddress?: string) =>
  app.inject({ method: 'POST', url, payload, ...(remoteAddress ? { remoteAddress } : {}) });

async function authorize(c: Awaited<ReturnType<typeof setup>>['c'], deviceId = randomUUID()) {
  const p = pkce();
  const r = await c.post(DESKTOP_AUTH_PATHS.authorize, {
    codeChallenge: p.challenge,
    codeChallengeMethod: 'S256',
    redirectUri: REDIRECT,
    deviceId,
  });
  expect(r.statusCode).toBe(200);
  return { ...p, deviceId, code: r.json<{ authorizationCode: string }>().authorizationCode };
}

async function signIn(s: Awaited<ReturnType<typeof setup>>) {
  const a = await authorize(s.c);
  const t = await post(s.app, DESKTOP_AUTH_PATHS.token, {
    authorizationCode: a.code,
    codeVerifier: a.verifier,
    redirectUri: REDIRECT,
    deviceId: a.deviceId,
  });
  expect(t.statusCode).toBe(200);
  return { ...a, tokens: t.json<Tokens>() };
}

describe('desktop auth (ADR-012, behind DESKTOP_AUTH_ENABLED)', () => {
  it('routes are not registered by default', async () => {
    const { app, c } = await setup(false);
    const r = await c.post(DESKTOP_AUTH_PATHS.authorize, {
      codeChallenge: pkce().challenge,
      codeChallengeMethod: 'S256',
      redirectUri: REDIRECT,
      deviceId: randomUUID(),
    });
    expect(r.statusCode).toBe(404);
    expect((await post(app, DESKTOP_AUTH_PATHS.refresh, {})).statusCode).toBe(404);
  });

  it('authorizes, exchanges with PKCE, stores only hashes, and the code is single-use', async () => {
    const s = await setup();
    const { tokens, code, verifier, deviceId } = await signIn(s);
    expect(tokens.organizationId).toBe(s.orgId);
    expect(tokens.scopes).toEqual([...DESKTOP_SCOPES]);
    expect(await s.desktopTokens.findAccess(sha(tokens.accessToken))).not.toBeNull();
    expect(JSON.stringify(s.desktopTokens)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(s.desktopTokens)).not.toContain(code);
    const replay = await post(s.app, DESKTOP_AUTH_PATHS.token, {
      authorizationCode: code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      deviceId,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects a wrong verifier, redirect URI or device, and burns the code on the attempt', async () => {
    const s = await setup();
    let n = 0;
    for (const bad of [
      { codeVerifier: pkce().verifier },
      { redirectUri: 'http://127.0.0.1:53683/callback' },
      { deviceId: randomUUID() },
    ]) {
      const a = await authorize(s.c);
      const body = {
        authorizationCode: a.code,
        codeVerifier: a.verifier,
        redirectUri: REDIRECT,
        deviceId: a.deviceId,
      };
      // A distinct client IP per round keeps the per-IP limit (failures count double) out of the way.
      const ip = `10.0.0.${++n}`;
      const bad1 = await post(s.app, DESKTOP_AUTH_PATHS.token, { ...body, ...bad }, ip);
      expect(bad1.statusCode).toBe(401);
      expect((await post(s.app, DESKTOP_AUTH_PATHS.token, body, ip)).statusCode).toBe(401);
    }
  });

  it('rejects non-loopback redirect URIs and plain PKCE at the schema', async () => {
    const s = await setup();
    const base = {
      codeChallenge: pkce().challenge,
      codeChallengeMethod: 'S256',
      redirectUri: REDIRECT,
      deviceId: randomUUID(),
    };
    for (const bad of [
      { redirectUri: 'http://localhost:53682/callback' },
      { redirectUri: 'https://127.0.0.1:53682/callback' },
      { redirectUri: 'http://127.0.0.1:80/callback' },
      { redirectUri: 'http://127.0.0.1:53682/callback?x=1' },
      { codeChallengeMethod: 'plain' },
    ])
      expect((await s.c.post(DESKTOP_AUTH_PATHS.authorize, { ...base, ...bad })).statusCode).toBe(
        400,
      );
  });

  it('rejects a session cookie on app routes', async () => {
    const s = await setup();
    const { tokens, deviceId } = await signIn(s);
    const r = await s.c.post(DESKTOP_AUTH_PATHS.refresh, {
      deviceId,
      refreshToken: tokens.refreshToken,
    });
    expect(r.statusCode).toBe(401);
  });

  it('rotates on refresh and revokes the family on reuse', async () => {
    const s = await setup();
    const { tokens: t1, deviceId } = await signIn(s);
    const r1 = await post(s.app, DESKTOP_AUTH_PATHS.refresh, {
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(r1.statusCode).toBe(200);
    const t2 = r1.json<Tokens>();
    expect(t2.refreshToken).not.toBe(t1.refreshToken);
    const reuse = await post(s.app, DESKTOP_AUTH_PATHS.refresh, {
      deviceId,
      refreshToken: t1.refreshToken,
    });
    expect(reuse.statusCode).toBe(401);
    const after = await post(s.app, DESKTOP_AUTH_PATHS.refresh, {
      deviceId,
      refreshToken: t2.refreshToken,
    });
    expect(after.statusCode).toBe(401);
  });

  it('revoke is idempotent and ends the family', async () => {
    const s = await setup();
    const { tokens, deviceId } = await signIn(s);
    const body = { deviceId, refreshToken: tokens.refreshToken };
    expect((await post(s.app, DESKTOP_AUTH_PATHS.revoke, body)).json()).toEqual({ revoked: true });
    expect((await post(s.app, DESKTOP_AUTH_PATHS.revoke, body)).statusCode).toBe(200);
    expect((await post(s.app, DESKTOP_AUTH_PATHS.refresh, body)).statusCode).toBe(401);
    expect(
      (await post(s.app, DESKTOP_AUTH_PATHS.revoke, { ...body, deviceId: randomUUID() }))
        .statusCode,
    ).toBe(401);
  });

  it('switch-org issues a new family for a member org and 404s (without consuming) otherwise', async () => {
    const s = await setup();
    const { tokens, deviceId } = await signIn(s);
    const other = await s.c.post('/orgs', { name: 'Second Org' });
    const otherId = other.json<{ organization: { id: string } }>().organization.id;
    const notMine = await post(s.app, DESKTOP_AUTH_PATHS.switchOrg, {
      deviceId,
      refreshToken: tokens.refreshToken,
      organizationId: randomUUID(),
    });
    expect(notMine.statusCode).toBe(404);
    const sw = await post(s.app, DESKTOP_AUTH_PATHS.switchOrg, {
      deviceId,
      refreshToken: tokens.refreshToken,
      organizationId: otherId,
    });
    expect(sw.statusCode).toBe(200);
    const t2 = sw.json<Tokens & { refreshExpiresAt: string }>();
    expect(t2.organizationId).toBe(otherId);
    const oldAccess = await s.desktopTokens.findAccess(sha(tokens.accessToken));
    const oldFamily = await s.desktopTokens.findFamily(oldAccess!.familyId);
    expect(oldFamily?.revokedAt).not.toBeNull();
    expect(t2.refreshExpiresAt).toBe(oldFamily!.maxExpiresAt.toISOString());
  });

  it('web logout-all also revokes desktop families', async () => {
    const s = await setup();
    const { tokens, deviceId } = await signIn(s);
    expect((await s.c.post('/auth/logout-all', {})).statusCode).toBeLessThan(300);
    const r = await post(s.app, DESKTOP_AUTH_PATHS.refresh, {
      deviceId,
      refreshToken: tokens.refreshToken,
    });
    expect(r.statusCode).toBe(401);
  });

  it('desktop bearers verify as credential "desktop" only when the audience is enabled', async () => {
    const s = await setup();
    const { tokens } = await signIn(s);
    const store = new DesktopAuthService({
      desktopTokens: s.desktopTokens,
      clock: { now: () => new Date() },
    } as unknown as DesktopAuthDeps).verifierStore();
    const sessions = {
      findSessionByTokenHash: async () => null,
      findMembership: async () => ({ role: 'admin' as const, deletedAt: null }),
    };
    const on = createSessionVerifier({
      sessions,
      extensionTokens: store,
      bearerAudiences: ['desktop'],
    });
    const off = createSessionVerifier({ sessions, extensionTokens: store });
    expect((await on.verifySession({ bearer: tokens.accessToken }))?.credential).toBe('desktop');
    expect(await off.verifySession({ bearer: tokens.accessToken })).toBeNull();
  });

  it('token, refresh, revoke and switch-org send no CORS headers to any origin (review B 2.2)', async () => {
    const s = await setup();
    const { tokens, deviceId } = await signIn(s);
    const body = { deviceId, refreshToken: tokens.refreshToken };
    const origins = [
      'http://localhost:5173',
      'https://evil.example',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'tauri://localhost',
      'null',
    ];
    const paths = [
      DESKTOP_AUTH_PATHS.token,
      DESKTOP_AUTH_PATHS.refresh,
      DESKTOP_AUTH_PATHS.revoke,
      DESKTOP_AUTH_PATHS.switchOrg,
    ];
    for (const url of paths)
      for (const origin of origins) {
        const pre = await s.app.inject({
          method: 'OPTIONS',
          url,
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        });
        const res = await s.app.inject({ method: 'POST', url, payload: body, headers: { origin } });
        for (const r of [pre, res]) {
          const cors = Object.keys(r.headers).filter((h) => h.startsWith('access-control-'));
          expect(cors, `${r.raw.req.method} ${url} ${origin}`).toEqual([]);
        }
      }
  });

  it('pkceS256Matches follows RFC 7636 appendix B', () => {
    expect(
      pkceS256Matches(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      ),
    ).toBe(true);
    expect(pkceS256Matches('x'.repeat(43), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(
      false,
    );
  });
});
