import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { CENSOR, CIRCULAR, createLogger, redactDeep, TRUNCATED } from '../src/index.js';

describe('pino paths are single-level (why the walker exists)', () => {
  it('fast-redact `*.token` misses a nested token', () => {
    const lines: string[] = [];
    const l = pino(
      { redact: { paths: ['*.token'] } },
      new Writable({ write: (c: Buffer, _e, cb) => (lines.push(c.toString()), cb()) }),
    );
    l.info({ a: { b: { token: 'S' } } });
    expect(lines[0]).toContain('"token":"S"');
  });
});

describe('redactDeep', () => {
  const keys = ['accessToken', 'authorization', 'set-cookie'];
  it('redacts matching keys case-insensitively at any depth, including inside arrays', () => {
    const out = redactDeep(
      {
        a: { b: { c: { d: { AccessToken: 'x', ok: 1 } } } },
        list: [{ Authorization: 'Bearer y' }],
      },
      keys,
    );
    expect(out).toEqual({
      a: { b: { c: { d: { AccessToken: CENSOR, ok: 1 } } } },
      list: [{ Authorization: CENSOR }],
    });
  });
  it('replaces a whole object value under a sensitive key', () => {
    expect(redactDeep({ 'set-cookie': ['a', 'b'] }, keys)).toEqual({ 'set-cookie': CENSOR });
  });
  it('caps depth and size, and marks cycles', () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 50; i++) cur = cur.n = {};
    expect(JSON.stringify(redactDeep(deep, keys, { maxDepth: 3 }))).toContain(TRUNCATED);
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, { v: i }]));
    const w = redactDeep(wide, keys, { maxNodes: 10 }) as Record<string, unknown>;
    expect(w.k99).toBe(TRUNCATED);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(redactDeep(cyc, keys)).toEqual({ a: 1, self: CIRCULAR });
  });
  it('walks Errors (keeps message) and leaves class instances alone', () => {
    const e = Object.assign(new Error('boom'), {
      config: { headers: { authorization: 'Bearer z' } },
    });
    const out = redactDeep({ err: e, at: new Date(0) }, keys) as {
      err: Record<string, unknown>;
      at: unknown;
    };
    expect(out.err.message).toBe('boom');
    expect(out.err.config).toEqual({ headers: { authorization: CENSOR } });
    expect(out.at).toBeInstanceOf(Date);
  });
});

describe('createLogger', () => {
  const run = (fn: (l: pino.Logger) => void, opts: Parameters<typeof createLogger>[0] = {}) => {
    const lines: string[] = [];
    const dest = new Writable({ write: (c: Buffer, _e, cb) => (lines.push(c.toString()), cb()) });
    fn(createLogger({ ...opts, level: 'info' }, dest));
    return lines.join('');
  };
  it('redacts nested default and extra keys in log objects and child bindings', () => {
    const out = run(
      (l) => {
        l.child({ ctx: { deep: { refreshToken: 'SEKRET_R' } } }).info({
          a: { b: { c: { pairingCode: 'SEKRET_P', customSecretKey: 'SEKRET_K', fine: 'ok' } } },
        });
      },
      { redactKeys: ['customSecretKey'] },
    );
    expect(out).not.toMatch(/SEKRET_/);
    expect(out).toContain('"fine":"ok"');
    expect(out).toContain(CENSOR);
  });
  it('still redacts serialized request headers by path', () => {
    const out = run((l) => l.info({ req: { headers: { authorization: 'Bearer q', host: 'h' } } }));
    expect(out).not.toContain('Bearer q');
    expect(out).toContain('"host":"h"');
  });
});

describe('child loggers', () => {
  it('grandchildren keep their parent bindings and serializers', () => {
    const lines: string[] = [];
    const root = createLogger({ level: 'info' }, { write: (l: string) => void lines.push(l) });
    const c = root.child({ a: 1 }, { serializers: { x: () => 'SERIALIZED' } });
    c.child({ b: { accessToken: 'SEKRET_T' } }).info({ x: { raw: true } });
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({ a: 1, b: { accessToken: CENSOR }, x: 'SERIALIZED' });
  });
});

describe('exports', () => {
  it('keeps the shared `logger` singleton', async () => {
    const m = await import('../src/index.js');
    expect(typeof m.logger.info).toBe('function');
  });
});

describe('redactUrl / request serializer (PR #263 M-1)', () => {
  it('redacts sensitive query values and keeps names and other params', async () => {
    const { redactUrl } = await import('../src/index.js');
    expect(redactUrl('/notifications/unsubscribe?token=abc.def')).toBe(
      '/notifications/unsubscribe?token=***redacted***',
    );
    expect(redactUrl('/cb?state=s&code=c&limit=5')).toBe(
      '/cb?state=***redacted***&code=***redacted***&limit=5',
    );
    expect(redactUrl('/x?TOKEN=a#frag')).toBe('/x?TOKEN=***redacted***');
    expect(redactUrl('/x?accessToken=a&cursor=c')).toBe('/x?accessToken=***redacted***&cursor=c');
    expect(redactUrl('/plain')).toBe('/plain');
    expect(redactUrl('/x?%E0%A4%A=1')).toBe('/x');
  });

  it('createLogger req serializer never writes the token', async () => {
    const { createLogger } = await import('../src/index.js');
    const lines: string[] = [];
    const log = createLogger(
      { name: 't', level: 'info' },
      { write: (s: string) => void lines.push(s) },
    );
    log.info(
      {
        req: {
          method: 'GET',
          url: '/notifications/unsubscribe?token=SECRET-TOKEN',
          host: 'h',
          ip: '1.2.3.4',
        },
      },
      'incoming request',
    );
    expect(lines.join('')).not.toContain('SECRET-TOKEN');
    expect(JSON.parse(lines[0]!).req).toMatchObject({
      method: 'GET',
      url: '/notifications/unsubscribe?token=***redacted***',
    });
  });

  it('redacts Web Push keys.auth (L-1)', async () => {
    const { redactDeep, DEFAULT_REDACT_KEYS } = await import('../src/index.js');
    expect(
      redactDeep(
        { subscription: { endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } } },
        DEFAULT_REDACT_KEYS,
      ),
    ).toEqual({
      subscription: { endpoint: 'e', keys: { p256dh: '***redacted***', auth: '***redacted***' } },
    });
  });
});
