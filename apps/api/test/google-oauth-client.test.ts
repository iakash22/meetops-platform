import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_MAX_RESPONSE_BYTES,
  JWKS_MIN_REFRESH_INTERVAL_MS,
  createGoogleOAuthClient,
} from '../src/modules/auth/application/google-oauth.js';
import { GoogleTokenError } from '../src/modules/auth/application/google-oidc.js';

/** OIDC review N-5 / L-3 / N-6: JWKS cache behaviour and token-exchange errors, with a scripted fetch. */
const CONFIG = {
  clientId: '1234567890-abc.apps.googleusercontent.com',
  clientSecret: 'test-secret-value',
  redirectUri: 'http://localhost:5173/api/auth/google/callback',
};
const EXPECT = { audience: CONFIG.clientId, nonce: 'n'.repeat(32), now: new Date() };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (kid: string) => ({ ...(publicKey.export({ format: 'jwk' }) as object), kid });
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
/** A valid ID token signed by the test key under `kid`: it verifies iff the client found that kid's key. */
function idToken(kid: string) {
  const t = Math.floor(EXPECT.now.getTime() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const b = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CONFIG.clientId,
      sub: '1',
      email: 'a@gmail.com',
      email_verified: true,
      nonce: EXPECT.nonce,
      iat: t,
      exp: t + 300,
    }),
  ).toString('base64url');
  const sig = createSign('RSA-SHA256').update(`${h}.${b}`).sign(privateKey).toString('base64url');
  return `${h}.${b}.${sig}`;
}

function harness(responder: (n: number) => Promise<Response> | Response) {
  let clock = 1_000_000;
  let calls = 0;
  const fetchImpl = (async () => responder(++calls)) as unknown as typeof fetch;
  const client = createGoogleOAuthClient(fetchImpl, { now: () => clock });
  return {
    client,
    calls: () => calls,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

/** 'verified' when the kid's key was available, 'rejected' (GoogleTokenError) otherwise. */
async function lookup(client: ReturnType<typeof createGoogleOAuthClient>, kid: string) {
  try {
    await client.verifyIdToken(idToken(kid), EXPECT);
    return 'verified';
  } catch (e) {
    expect(e).toBeInstanceOf(GoogleTokenError);
    return 'rejected';
  }
}

describe('Google JWKS client', () => {
  it('single flight: concurrent lookups share one fetch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async () => {
      await gate;
      return json({ keys: [jwk('a')] });
    });
    const pending = Promise.all([
      lookup(h.client, 'a'),
      lookup(h.client, 'a'),
      lookup(h.client, 'a'),
    ]);
    release();
    expect(await pending).toEqual(['verified', 'verified', 'verified']);
    expect(h.calls()).toBe(1);
  });

  it('L-3: unknown kids refresh at most once per minute', async () => {
    const h = harness(() => json({ keys: [jwk('a')] }));
    expect(await lookup(h.client, 'a')).toBe('verified');
    for (let i = 0; i < 10; i++) expect(await lookup(h.client, `nope-${i}`)).toBe('rejected');
    expect(h.calls()).toBe(1);
    h.tick(JWKS_MIN_REFRESH_INTERVAL_MS);
    await lookup(h.client, 'still-nope');
    expect(h.calls()).toBe(2);
  });

  it('N-5: a failed refresh keeps serving the cached keys', async () => {
    const h = harness((n) =>
      n === 1 ? json({ keys: [jwk('a')] }) : new Response('', { status: 500 }),
    );
    expect(await lookup(h.client, 'a')).toBe('verified');
    h.tick(61 * 60 * 1000); // stale -> one refresh attempt, which fails
    expect(await lookup(h.client, 'a')).toBe('verified');
    expect(h.calls()).toBe(2);
    // ...but never once the cache is a day old.
    h.tick(24 * 60 * 60 * 1000);
    expect(await lookup(h.client, 'a')).toBe('rejected');
  });

  it('fails closed with no cache when Google is unreachable or the body is oversized', async () => {
    const down = harness(() => {
      throw new TypeError('network');
    });
    expect(await lookup(down.client, 'a')).toBe('rejected');
    const huge = harness(
      () =>
        new Response('x'.repeat(GOOGLE_MAX_RESPONSE_BYTES + 1), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(await lookup(huge.client, 'a')).toBe('rejected');
  });
});

describe('Google token exchange errors', () => {
  const exchange = (res: () => Response | Promise<Response>) =>
    createGoogleOAuthClient((async () => res()) as unknown as typeof fetch).exchangeCode({
      code: 'c',
      codeVerifier: 'v'.repeat(43),
      config: CONFIG,
    });

  it('returns the id_token on success', async () => {
    await expect(exchange(() => json({ id_token: 'tok' }))).resolves.toBe('tok');
  });
  it.each([
    ['a 400 invalid_grant', () => json({ error: 'invalid_grant' }, { status: 400 })],
    ['a body without id_token', () => json({ access_token: 'x' })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
    ['an oversized body', () => json({ id_token: 'x'.repeat(GOOGLE_MAX_RESPONSE_BYTES) })],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('maps %s to GoogleTokenError without its text', async (_label, res) => {
    const err = await exchange(res as () => Response).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleTokenError);
    expect(String((err as Error).message)).not.toMatch(/invalid_grant|html|fetch failed/);
  });
});
