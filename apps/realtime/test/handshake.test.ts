import { describe, expect, it } from 'vitest';
import {
  classifyOrigin,
  readCookies,
  readHandshakeCredential,
  type HandshakePolicy,
} from '../src/index.js';
import { COOKIE, EXT_ORIGIN, ORIGIN } from './fixtures.js';

const policy: HandshakePolicy = {
  webOrigins: new Set([ORIGIN]),
  extensionOrigins: new Set([EXT_ORIGIN]),
  sessionCookieName: COOKIE,
};
const q = { EIO: '4', transport: 'websocket' };

describe('readHandshakeCredential', () => {
  it('classifies origins', () => {
    expect(classifyOrigin(ORIGIN, policy)).toBe('web');
    expect(classifyOrigin(`${ORIGIN}/`, policy)).toBe('web');
    expect(
      classifyOrigin(
        EXT_ORIGIN.toUpperCase().replace('CHROME-EXTENSION', 'chrome-extension'),
        policy,
      ),
    ).toBe('extension');
    expect(
      classifyOrigin('chrome-extension://pppppppppppppppppppppppppppppppp', policy),
    ).toBeNull();
    expect(classifyOrigin(['a', 'b'], policy)).toBeNull();
    expect(classifyOrigin(undefined, policy)).toBeNull();
  });

  it('parses cookies', () => {
    expect(readCookies(`a=1; ${COOKIE}="x%20y"`, COOKIE)).toEqual(['x y']);
    expect(readCookies(undefined, COOKIE)).toEqual([]);
    expect(readCookies([`${COOKIE}=1`, `${COOKIE}=2`], COOKIE)).toEqual(['1', '2']);
  });

  it('web: cookie only', () => {
    const h = (cookie: string | undefined, auth: unknown) => ({
      headers: { origin: ORIGIN, cookie },
      query: q,
      auth,
    });
    expect(readHandshakeCredential(h(`${COOKIE}=abc`, {}), policy)).toEqual({
      ok: true,
      kind: 'web',
      credential: { cookie: 'abc' },
    });
    expect(readHandshakeCredential(h(`${COOKIE}=abc`, { token: 't' }), policy)).toEqual({
      ok: false,
    });
    expect(readHandshakeCredential(h(`${COOKIE}=abc`, { token: '' }), policy)).toEqual({
      ok: false,
    });
    expect(readHandshakeCredential(h(`${COOKIE}=`, {}), policy)).toEqual({ ok: false });
    expect(readHandshakeCredential(h(undefined, {}), policy)).toEqual({ ok: false });
  });

  it('extension: bearer only', () => {
    const h = (cookie: string | undefined, auth: unknown) => ({
      headers: { origin: EXT_ORIGIN, cookie },
      query: q,
      auth,
    });
    expect(readHandshakeCredential(h(undefined, { token: 't' }), policy)).toEqual({
      ok: true,
      kind: 'extension',
      credential: { bearer: 't' },
    });
    expect(readHandshakeCredential(h('other=1', { token: 't' }), policy)).toEqual({
      ok: true,
      kind: 'extension',
      credential: { bearer: 't' },
    });
    expect(readHandshakeCredential(h(`${COOKIE}=abc`, { token: 't' }), policy)).toEqual({
      ok: false,
    });
    expect(readHandshakeCredential(h(undefined, { token: '' }), policy)).toEqual({ ok: false });
    expect(readHandshakeCredential(h(undefined, null), policy)).toEqual({ ok: false });
  });

  it('rejects any non-Engine.IO query key', () => {
    const base = { headers: { origin: ORIGIN, cookie: `${COOKIE}=abc` }, auth: {} };
    expect(
      readHandshakeCredential({ ...base, query: { ...q, t: 'x', b64: '1', j: '0' } }, policy).ok,
    ).toBe(true);
    for (const k of ['token', 'access_token', 'auth', 'sid', 'x'])
      expect(readHandshakeCredential({ ...base, query: { ...q, [k]: 'v' } }, policy)).toEqual({
        ok: false,
      });
  });
});
