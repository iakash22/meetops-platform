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

describe('#282 M-1 integration secrets and free-text scrub', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info' }, { write: (l: string) => void lines.push(l) });
  const kind = ['RSA', 'PRIVATE', 'KEY'].join(' ');
  const pem = [`-----BEGIN ${kind}-----`, 'x'.repeat(24), `-----END ${kind}-----`].join('\n');
  const tok = (p: string) => `${p}_${'z'.repeat(36)}`;
  it('redacts the new keys at any depth', () => {
    lines.length = 0;
    const keys = [
      'webhook_secret',
      'private_key',
      'pem',
      'installationToken',
      'jwt',
      'id_token',
      'GITHUB_APP_CLIENT_SECRET',
      'JIRA_CLIENT_SECRET',
    ];
    log.info({ deep: { nest: Object.fromEntries(keys.map((k) => [k, `SEKRET_${k}`])) } });
    expect(lines.join('')).not.toMatch(/SEKRET_/);
  });
  it('redacts an OAuth `code` but keeps error codes', () => {
    lines.length = 0;
    log.info({
      q: { code: 'a1b2c3d4e5oauthcode' },
      err: { code: 'ECONNREFUSED' },
      body: { code: 'VALIDATION_FAILED' },
      http: { code: 404 },
    });
    const out = lines.join('');
    expect(out).not.toContain('a1b2c3d4e5oauthcode');
    expect(out).toContain('ECONNREFUSED');
    expect(out).toContain('VALIDATION_FAILED');
    expect(out).toContain('404');
  });
  it('scrubs PEM blocks and ghs_/ghu_/gho_ tokens in messages, error messages and string values', () => {
    lines.length = 0;
    log.info(`key was ${pem} and ${tok('ghs')}`);
    log.error({ err: new Error(`boom ${tok('ghu')} ${pem}`), note: `t=${tok('gho')}` }, 'failed');
    const out = lines.join('');
    expect(out).not.toMatch(/PRIVATE KEY|x{24}|gh[osu]_z{36}/);
    expect(out).toContain('key was');
    expect(out).toContain('boom');
  });
  it('redactDeep scrubs nested strings directly', () => {
    expect(JSON.stringify(redactDeep({ a: [`x ${tok('ghs')}`] }, []))).not.toMatch(/ghs_z{36}/);
  });
});
