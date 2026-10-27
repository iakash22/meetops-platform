import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts';
import { InMemoryExtensionTokenRepository } from '../src/modules/extension-auth/index.js';
import { buildApp, signupAndLogin, type App } from './helpers.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const nonce = () => createHash('sha256').update(randomUUID()).digest('base64url');
const ext = (app: App, url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload, headers: { origin: `chrome-extension://${EXT}` } });

type Entry = { obj: Record<string, unknown>; msg: string };

async function pairedDevice(log: Entry[]) {
  const app = await buildApp({
    extensionTokens: new InMemoryExtensionTokenRepository(),
    extensionIds: [EXT],
    extensionAuthLog: { warn: (obj, msg) => void log.push({ obj, msg }) },
  });
  const c = await signupAndLogin(app, `freq-${randomUUID()}@example.com`);
  expect((await c.post('/orgs', { name: 'Freq Org' })).statusCode).toBe(201);
  const pair = async () => {
    const deviceId = randomUUID();
    const n = nonce();
    const p = await c.post(EXTENSION_AUTH_PATHS.pair, { extensionId: EXT, deviceId, nonce: n });
    const { pairingCode } = p.json<{ pairingCode: string }>();
    const t = await ext(app, EXTENSION_AUTH_PATHS.token, {
      extensionId: EXT,
      deviceId,
      pairingCode,
      nonce: n,
    });
    expect(t.statusCode).toBe(200);
    let refreshToken = t.json<{ refreshToken: string }>().refreshToken;
    const refresh = async () => {
      const r = await ext(app, EXTENSION_AUTH_PATHS.refresh, {
        extensionId: EXT,
        deviceId,
        refreshToken,
      });
      expect(r.statusCode).toBe(200);
      refreshToken = r.json<{ refreshToken: string }>().refreshToken;
      return refreshToken;
    };
    return { deviceId, refresh };
  };
  return { app, pair };
}

describe('frequent refresh is logged (ADR-005 A1.4 SHOULD)', () => {
  it('logs the second refresh within 60s of the first for the same family, without rejecting it', async () => {
    const log: Entry[] = [];
    const { app, pair } = await pairedDevice(log);
    const d = await pair();
    await d.refresh();
    expect(log).toHaveLength(0);
    const second = await d.refresh();
    expect(log).toHaveLength(1);
    expect(log[0]!.obj).toMatchObject({
      event: 'extension.token.refresh_frequent',
      deviceId: d.deviceId,
      extensionId: EXT,
      windowSeconds: 60,
    });
    expect(log[0]!.obj.familyId).toEqual(expect.any(String));
    // No token material in the log line.
    expect(JSON.stringify(log)).not.toContain(second);
    await app.close();
  });

  it('tracks families separately', async () => {
    const log: Entry[] = [];
    const { app, pair } = await pairedDevice(log);
    const a = await pair();
    const b = await pair();
    await a.refresh();
    await b.refresh();
    expect(log).toHaveLength(0);
    await b.refresh();
    expect(log.map((e) => e.obj.deviceId)).toEqual([b.deviceId]);
    await app.close();
  });
});
