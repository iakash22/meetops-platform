import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from './helpers.js';
import { defaultModuleDeps, inMemoryMediaAdapters } from '../src/modules/index.js';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = `chrome-extension://${EXT}`;
const OTHER_EXT_ORIGIN = `chrome-extension://${'z'.repeat(32)}`;
const ORG = '00000000-0000-4000-8000-000000000001';
const SESSION = '00000000-0000-4000-8000-000000000002';
const WEB = 'http://localhost:5173';

const routes = [
  `/orgs/${ORG}/meetings/resolve`,
  `/orgs/${ORG}/recording-sessions`,
  `/recording-sessions/${SESSION}/chunks`,
  `/recording-sessions/${SESSION}/complete`,
  `/recording-sessions/${SESSION}/abort`,
  `/orgs/${ORG}/uploads`,
  `/orgs/${ORG}/uploads/${SESSION}/complete`,
];

describe('ADR-005 A1.3.6: extension CORS on bearer-enabled routes', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp(
      defaultModuleDeps({ media: inMemoryMediaAdapters(), extensionIds: [EXT] }),
    );
  });
  afterAll(async () => app.close());

  const preflight = (url: string, origin: string, headers = 'authorization, content-type') =>
    app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': headers,
      },
    });

  it.each(routes)('allowed extension origin: credential-less preflight on %s', async (url) => {
    const r = await preflight(url, EXT_ORIGIN);
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers['access-control-allow-headers']).toBe('authorization, content-type');
    expect(r.headers['access-control-allow-methods']).toBe('POST');
    expect(r.headers.vary).toContain('Origin');
  });

  it('allowed extension origin: the actual (401) response carries ACAO without credentials', async () => {
    const r = await app.inject({
      method: 'POST',
      url: routes[0]!,
      headers: { origin: EXT_ORIGIN, authorization: `Bearer ${'x'.repeat(43)}` },
      payload: { source: 'extension', externalMeetingUrl: 'https://meet.google.com/a', title: 'S' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('disallowed extension id: no CORS headers on preflight or request', async () => {
    const p = await preflight(routes[1]!, OTHER_EXT_ORIGIN);
    expect(p.headers['access-control-allow-origin']).toBeUndefined();
    expect(p.headers['access-control-allow-credentials']).toBeUndefined();
    expect(p.headers['access-control-allow-headers']).toBeUndefined();
    const r = await app.inject({
      method: 'POST',
      url: routes[1]!,
      headers: { origin: OTHER_EXT_ORIGIN, authorization: `Bearer ${'x'.repeat(43)}` },
      payload: {},
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('web origin keeps credentialed CORS on the same routes', async () => {
    const p = await preflight(routes[0]!, WEB, 'content-type, x-csrf-token');
    expect(p.statusCode).toBe(204);
    expect(p.headers['access-control-allow-origin']).toBe(WEB);
    expect(p.headers['access-control-allow-credentials']).toBe('true');
    expect(String(p.headers['access-control-allow-headers'])).toContain('x-csrf-token');
    expect(String(p.headers['access-control-allow-headers'])).not.toContain('authorization');
  });

  it('extension origin on a non-bearer route gets no CORS', async () => {
    const p = await preflight(`/orgs/${ORG}/meetings`, EXT_ORIGIN);
    expect(p.headers['access-control-allow-origin']).toBeUndefined();
  });
});
