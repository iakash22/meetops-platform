import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthService,
  BearerScopeError,
  NONCE_KEY,
  NotPairedError,
  REPAIR_KEY,
  TOKENS_KEY,
  type AuthDeps,
  type StoredTokens,
} from '../src/lib/auth/auth-service.js';
import { NONCE_TTL_MS } from '../src/lib/auth/config.js';
import { validators } from '../src/lib/auth/validate.js';
import { memoryKV } from '../src/lib/storage.js';
import { createFetchTransport } from '../src/lib/upload.js';
import { redact, safeErrorMessage } from '../src/lib/redact.js';

const WEB = 'https://app.meetops.ai';
const API = 'https://api.meetops.ai';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const DEVICE = '0b5a3c4e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const ORG = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const ORG2 = '8d2e3f4a-5b6c-4d7e-9f8a-0b1c2d3e4f5a';
const CODE = 'P'.repeat(43);
const T0 = Date.parse('2026-10-22T08:00:00.000Z');

type Call = { url: string; init: RequestInit };
type Handler = (call: Call) => { status: number; body?: unknown };

const tok = (c: string) => c.repeat(43);

function tokenBody(
  o: { nonce?: string; access?: string; refresh?: string; org?: string; now?: number } = {},
) {
  const now = o.now ?? T0;
  return {
    accessToken: o.access ?? tok('a'),
    refreshToken: o.refresh ?? tok('r'),
    tokenType: 'Bearer',
    audience: 'extension',
    expiresAt: new Date(now + 900_000).toISOString(),
    expiresIn: 900,
    refreshExpiresAt: new Date(T0 + 30 * 86_400_000).toISOString(),
    organizationId: o.org ?? ORG,
    scopes: ['meetings:resolve', 'recordings:write'],
    ...(o.nonce !== undefined ? { nonce: o.nonce } : {}),
  };
}

function setup(handler: Handler) {
  let now = T0;
  const calls: Call[] = [];
  const session = memoryKV();
  const install = memoryKV();
  const alarms = {
    schedule: vi.fn<(when: number) => Promise<void>>(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const openTab = vi.fn<(url: string) => Promise<void>>(async () => {});
  const deps: AuthDeps = {
    session,
    install,
    config: { webOrigin: WEB, apiOrigin: API },
    extensionId: EXT_ID,
    now: () => now,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      const r = handler(call);
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
      });
    },
    randomBytes: (n) => new Uint8Array(n).fill(7),
    randomUUID: () => DEVICE,
    openTab,
    validators,
    alarms,
  };
  const auth = new AuthService(deps);
  return {
    auth,
    calls,
    session,
    alarms,
    install,
    openTab,
    advance: (ms: number) => (now += ms),
    nowMs: () => now,
  };
}

const body = (c: Call) => JSON.parse(c.init.body as string) as Record<string, unknown>;
const authz = (c: Call) => new Headers(c.init.headers).get('authorization');
const path = (c: Call) => new URL(c.url).pathname;

async function pair(s: ReturnType<typeof setup>) {
  await s.auth.startPairing();
  const nonce = (await s.session.get<{ value: string }>(NONCE_KEY))!.value;
  const ok = await s.auth.handleExternalMessage(
    { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce },
    { origin: WEB },
  );
  return { nonce, ok };
}

describe('pairing nonce', () => {
  it('generates a 256-bit base64url nonce in session storage on the gesture and opens the pairing page', async () => {
    const s = setup(() => ({ status: 500 }));
    await s.auth.startPairing();
    const n = await s.session.get<{ value: string; createdAt: number }>(NONCE_KEY);
    expect(n?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await s.install.get('auth.deviceId')).toBe(DEVICE);
    const url = new URL(s.openTab.mock.calls[0]![0]);
    expect(url.origin).toBe(WEB);
    expect(url.search).toBe('');
    const frag = new URLSearchParams(url.hash.slice(1));
    expect(frag.get('nonce')).toBe(n?.value);
    expect(frag.get('extensionId')).toBe(EXT_ID);
    expect(frag.get('deviceId')).toBe(DEVICE);
    expect((await s.auth.status()).state).toBe('pairing');
  });

  it('is single use: a replayed handoff is rejected', async () => {
    const s = setup((c) => ({ status: 200, body: tokenBody({ nonce: body(c).nonce as string }) }));
    const { nonce, ok } = await pair(s);
    expect(ok).toBe(true);
    expect(await s.session.get(NONCE_KEY)).toBeUndefined();
    const again = await s.auth.handleExternalMessage(
      { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce },
      { origin: WEB },
    );
    expect(again).toBe(false);
    expect(s.calls).toHaveLength(1);
  });

  it('expires after 5 minutes', async () => {
    const s = setup(() => ({ status: 200, body: tokenBody() }));
    await s.auth.startPairing();
    const nonce = (await s.session.get<{ value: string }>(NONCE_KEY))!.value;
    s.advance(NONCE_TTL_MS);
    expect(
      await s.auth.handleExternalMessage(
        { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce },
        { origin: WEB },
      ),
    ).toBe(false);
    expect(await s.session.get(NONCE_KEY)).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });
});

describe('onMessageExternal checks', () => {
  const origins = [
    undefined,
    'https://evil.example',
    'http://app.meetops.ai',
    'https://app.meetops.ai.evil.example',
    'https://app.meetops.ai/',
    'https://APP.meetops.ai',
    'http://localhost:3000',
    'null',
  ];
  it.each(origins)(
    'rejects sender.origin %s without touching the nonce or network',
    async (origin) => {
      const s = setup(() => ({ status: 200, body: tokenBody() }));
      await s.auth.startPairing();
      const nonce = (await s.session.get<{ value: string }>(NONCE_KEY))!.value;
      const sender = origin === undefined ? { url: `${WEB}/extension/pair` } : { origin };
      expect(s.auth.acceptsOrigin(sender)).toBe(false);
      expect(
        await s.auth.handleExternalMessage(
          { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce },
          sender,
        ),
      ).toBe(false);
      expect(s.calls).toHaveLength(0);
      expect(await s.session.get(NONCE_KEY)).toBeDefined();
    },
  );

  it.each([
    ['not an object', 'hello'],
    ['missing pairingCode', { type: 'MEETOPS_PAIRING_CODE', nonce: 'n'.repeat(43) }],
    ['short code', { type: 'MEETOPS_PAIRING_CODE', pairingCode: 'abc', nonce: 'n'.repeat(43) }],
    ['bad nonce chars', { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce: '+'.repeat(43) }],
    [
      'extra property',
      { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce: 'n'.repeat(43), accessToken: 'x' },
    ],
    ['wrong type', { type: 'OTHER', pairingCode: CODE, nonce: 'n'.repeat(43) }],
  ])('rejects a schema-invalid handoff (%s)', async (_n, msg) => {
    const s = setup(() => ({ status: 200, body: tokenBody() }));
    await s.auth.startPairing();
    expect(await s.auth.handleExternalMessage(msg, { origin: WEB })).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a handoff nonce that differs from the stored one and keeps the stored nonce', async () => {
    const s = setup(() => ({ status: 200, body: tokenBody() }));
    await s.auth.startPairing();
    expect(
      await s.auth.handleExternalMessage(
        { type: 'MEETOPS_PAIRING_CODE', pairingCode: CODE, nonce: 'x'.repeat(43) },
        { origin: WEB },
      ),
    ).toBe(false);
    expect(s.calls).toHaveLength(0);
    expect(await s.session.get(NONCE_KEY)).toBeDefined();
  });
});

describe('token exchange', () => {
  it('posts ExtensionTokenRequest without cookie or bearer and stores tokens in session storage only', async () => {
    const s = setup((c) => ({ status: 200, body: tokenBody({ nonce: body(c).nonce as string }) }));
    const { nonce, ok } = await pair(s);
    expect(ok).toBe(true);
    const c = s.calls[0]!;
    expect(c.url).toBe(`${API}/auth/extension-token`);
    expect(c.init.credentials).toBe('omit');
    expect(authz(c)).toBeNull();
    expect(body(c)).toEqual({ extensionId: EXT_ID, deviceId: DEVICE, pairingCode: CODE, nonce });
    const t = await s.session.get<StoredTokens>(TOKENS_KEY);
    expect(t).toMatchObject({ accessToken: tok('a'), refreshToken: tok('r'), organizationId: ORG });
    expect(JSON.stringify([...s.install.data])).not.toContain(tok('a'));
    expect(await s.auth.status()).toMatchObject({ state: 'paired', organizationId: ORG });
    expect(JSON.stringify(await s.auth.status())).not.toContain(tok('a'));
  });

  it('rejects a token response whose nonce does not echo the stored nonce', async () => {
    const s = setup(() => ({ status: 200, body: tokenBody({ nonce: 'z'.repeat(43) }) }));
    const { ok } = await pair(s);
    expect(ok).toBe(false);
    expect(await s.session.get(TOKENS_KEY)).toBeUndefined();
    expect(await s.session.get(NONCE_KEY)).toBeUndefined();
  });

  it('rejects a token response that fails Value.Check (missing nonce / extra field / wrong audience)', async () => {
    for (const bad of [
      tokenBody(),
      { ...tokenBody({ nonce: 'n' }), extra: 1 },
      { ...tokenBody(), audience: 'web' },
    ]) {
      const s = setup((c) => ({
        status: 200,
        body: 'nonce' in bad ? { ...bad, nonce: body(c).nonce } : bad,
      }));
      expect((await pair(s)).ok).toBe(false);
      expect(await s.session.get(TOKENS_KEY)).toBeUndefined();
    }
  });

  it('fails closed on a non-2xx exchange', async () => {
    const s = setup(() => ({
      status: 401,
      body: { error: { code: 'AUTH_FAILED', message: 'x', requestId: 'r' } },
    }));
    expect((await pair(s)).ok).toBe(false);
    expect((await s.auth.status()).state).toBe('unpaired');
  });
});

describe('bearer scoping', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup((c) =>
      path(c) === '/auth/extension-token'
        ? { status: 200, body: tokenBody({ nonce: body(c).nonce as string }) }
        : { status: 200, body: { ok: true } },
    );
    await pair(s);
  });

  it('sends Authorization: Bearer to the API origin only', async () => {
    await s.auth.apiFetch(`/orgs/${ORG}/meetings/resolve`, { method: 'POST' });
    const c = s.calls.at(-1)!;
    expect(c.url).toBe(`${API}/orgs/${ORG}/meetings/resolve`);
    expect(authz(c)).toBe(`Bearer ${tok('a')}`);
    expect(c.init.credentials).toBe('omit');
  });

  it.each([
    'https://bucket.s3.amazonaws.com/chunk?X-Amz-Signature=x',
    '//evil.example/x',
    'https://api.meetops.ai.evil.example/x',
    'http://api.meetops.ai/x',
    'relative/x',
  ])('refuses to attach the bearer to %s', async (url) => {
    const before = s.calls.length;
    await expect(s.auth.apiFetch(url)).rejects.toBeInstanceOf(BearerScopeError);
    expect(s.calls).toHaveLength(before);
  });

  it('presigned PUT transport never forwards authorization or cookies', async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', f);
    try {
      await createFetchTransport({ allowLocalHttp: false })({
        url: 'https://bucket.example/obj?sig=1',
        method: 'PUT',
        headers: {
          'content-length': '3',
          Authorization: `Bearer ${tok('a')}`,
          Cookie: 'c=1',
          'x-amz-checksum-sha256': 'abc',
        },
        body: new Blob(['abc']),
      });
      const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(init.headers).toEqual({ 'x-amz-checksum-sha256': 'abc' });
      expect(init.credentials).toBe('omit');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('refresh and re-pair', () => {
  function server(
    o: {
      refresh?: (c: Call, n: number) => { status: number; body?: unknown };
      api?: (c: Call) => number;
    } = {},
  ) {
    let refreshes = 0;
    return (c: Call) => {
      if (path(c) === '/auth/extension-token')
        return { status: 200, body: tokenBody({ nonce: body(c).nonce as string }) };
      if (path(c) === '/auth/extension/refresh') {
        refreshes += 1;
        return (
          o.refresh?.(c, refreshes) ?? {
            status: 200,
            body: tokenBody({ access: tok('b'), refresh: tok('s') }),
          }
        );
      }
      if (path(c) === '/auth/extension/revoke') return { status: 200, body: { revoked: true } };
      return { status: o.api?.(c) ?? 200, body: {} };
    };
  }

  it('rotates the pair before expiry and uses the new access token', async () => {
    const s = setup(server());
    await pair(s);
    s.advance(900_000 - 30_000);
    await s.auth.apiFetch('/x');
    const r = s.calls.find((c) => path(c) === '/auth/extension/refresh')!;
    expect(body(r)).toEqual({ extensionId: EXT_ID, deviceId: DEVICE, refreshToken: tok('r') });
    expect(authz(r)).toBeNull();
    expect(authz(s.calls.at(-1)!)).toBe(`Bearer ${tok('b')}`);
    expect(await s.session.get<StoredTokens>(TOKENS_KEY)).toMatchObject({ refreshToken: tok('s') });
  });

  it('concurrent callers share one refresh (a refresh token is never presented twice)', async () => {
    const s = setup(server());
    await pair(s);
    s.advance(900_000);
    await Promise.all([s.auth.apiFetch('/a'), s.auth.apiFetch('/b'), s.auth.apiFetch('/c')]);
    expect(s.calls.filter((c) => path(c) === '/auth/extension/refresh')).toHaveLength(1);
  });

  it('re-pairs when the refresh token is rejected (reuse / revoked family)', async () => {
    const s = setup(
      server({
        refresh: () => ({
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } },
        }),
      }),
    );
    await pair(s);
    s.advance(900_000);
    await expect(s.auth.apiFetch('/x')).rejects.toBeInstanceOf(NotPairedError);
    expect(await s.session.get(TOKENS_KEY)).toBeUndefined();
    expect(await s.auth.status()).toEqual({ state: 'repair_required', reason: 'refresh_rejected' });
  });

  it('re-pairs on an org switch seen in the refresh response', async () => {
    const s = setup(
      server({
        refresh: () => ({
          status: 200,
          body: tokenBody({ access: tok('b'), refresh: tok('s'), org: ORG2 }),
        }),
      }),
    );
    await pair(s);
    s.advance(900_000);
    await expect(s.auth.apiFetch('/x')).rejects.toThrow(/org_switch/);
    expect(await s.session.get(TOKENS_KEY)).toBeUndefined();
    expect(await s.session.get(REPAIR_KEY)).toBe('org_switch');
  });

  it('rejects a refresh response that fails Value.Check or does not rotate', async () => {
    const s = setup(
      server({
        refresh: (_c, n) =>
          n === 1
            ? { status: 200, body: { ...tokenBody(), nonce: 'n'.repeat(43) } }
            : { status: 200, body: tokenBody() },
      }),
    );
    await pair(s);
    s.advance(900_000);
    await expect(s.auth.refresh()).rejects.toThrow(/Invalid refresh response/);
    await expect(s.auth.refresh()).rejects.toThrow(/did not rotate/);
  });

  it('on 401 refreshes once and retries; a second 401 requires re-pairing', async () => {
    let n = 0;
    const s = setup(server({ api: () => (++n === 1 ? 401 : 200) }));
    await pair(s);
    expect((await s.auth.apiFetch('/x')).status).toBe(200);
    expect(authz(s.calls.at(-1)!)).toBe(`Bearer ${tok('b')}`);

    const s2 = setup(server({ api: () => 401 }));
    await pair(s2);
    await expect(s2.auth.apiFetch('/x')).rejects.toThrow(/unauthorized/);
    expect(await s2.auth.status()).toEqual({ state: 'repair_required', reason: 'unauthorized' });
  });

  it('unpair revokes the family and clears session storage', async () => {
    const s = setup(server());
    await pair(s);
    await s.auth.unpair();
    const r = s.calls.at(-1)!;
    expect(path(r)).toBe('/auth/extension/revoke');
    expect(body(r)).toEqual({ extensionId: EXT_ID, deviceId: DEVICE, refreshToken: tok('r') });
    expect(await s.session.get(TOKENS_KEY)).toBeUndefined();
    expect((await s.auth.status()).state).toBe('unpaired');
  });

  it('accessToken throws NotPairedError when unpaired', async () => {
    const s = setup(server());
    await expect(s.auth.accessToken()).rejects.toBeInstanceOf(NotPairedError);
  });
});

describe('redaction', () => {
  it('redacts REDACT_KEYS at any depth and bearer values in messages', () => {
    expect(
      redact({ a: { accessToken: 'x', Authorization: 'y', list: [{ refreshToken: 'z' }] }, ok: 1 }),
    ).toEqual({
      a: {
        accessToken: '[REDACTED]',
        Authorization: '[REDACTED]',
        list: [{ refreshToken: '[REDACTED]' }],
      },
      ok: 1,
    });
    expect(safeErrorMessage(new Error('failed with Bearer abc.DEF-123'))).toBe(
      'failed with Bearer [REDACTED]',
    );
  });
});

describe('nonce expiry alarm (N1)', () => {
  it('schedules a one-shot alarm 5 minutes out when the nonce is created', async () => {
    const s = setup(() => ({ status: 500 }));
    await s.auth.startPairing();
    expect(s.alarms.schedule).toHaveBeenCalledTimes(1);
    expect(s.alarms.schedule).toHaveBeenCalledWith(T0 + NONCE_TTL_MS);
    expect(s.alarms.clear).not.toHaveBeenCalled();
  });

  it('deletes the nonce when the alarm fires at expiry, without a read', async () => {
    const s = setup(() => ({ status: 500 }));
    await s.auth.startPairing();
    s.advance(NONCE_TTL_MS);
    await s.auth.onNonceAlarm();
    expect(s.session.data.has(NONCE_KEY)).toBe(false);
  });

  it('re-arms instead of deleting if the alarm fires early, and ignores a missing nonce', async () => {
    const s = setup(() => ({ status: 500 }));
    await s.auth.startPairing();
    s.advance(60_000);
    await s.auth.onNonceAlarm();
    expect(s.session.data.has(NONCE_KEY)).toBe(true);
    expect(s.alarms.schedule).toHaveBeenLastCalledWith(T0 + NONCE_TTL_MS);
    await s.session.remove(NONCE_KEY);
    await expect(s.auth.onNonceAlarm()).resolves.toBeUndefined();
  });

  it('clears the alarm when the nonce is consumed', async () => {
    const s = setup((c) => ({ status: 200, body: tokenBody({ nonce: body(c).nonce as string }) }));
    expect((await pair(s)).ok).toBe(true);
    expect(s.alarms.clear).toHaveBeenCalled();
    expect(s.session.data.has(NONCE_KEY)).toBe(false);
  });

  it('clears the alarm on unpair', async () => {
    const s = setup(() => ({ status: 500 }));
    await s.auth.startPairing();
    await s.auth.unpair();
    expect(s.alarms.clear).toHaveBeenCalledTimes(1);
    expect(s.session.data.has(NONCE_KEY)).toBe(false);
  });
});
