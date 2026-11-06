import { createReadStream, mkdtempSync, rmSync, writeFileSync, type ReadStream } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  antivirusFromEnv,
  ClamdError,
  CLAMD_CLEAN_REPLY,
  createClamdScanner,
} from '../src/media/clamd.js';

const root = mkdtempSync(path.join(tmpdir(), 'clamd-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const f = path.join(root, 'x.bin');
writeFileSync(f, Buffer.alloc(200_000, 7));

/** Fake clamd: parses zINSTREAM framing, replies FOUND when the stream contains "EICAR". */
function fakeClamd(): Promise<{ server: Server; port: number; received: () => number }> {
  let total = 0;
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let headerDone = false;
    let body = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerDone) {
        const i = buf.indexOf(0);
        if (i < 0) return;
        expect(buf.subarray(0, i).toString()).toBe('zINSTREAM');
        buf = buf.subarray(i + 1);
        headerDone = true;
      }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          total = body.length;
          sock.end(
            body.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0',
          );
          return;
        }
        if (buf.length < 4 + n) return;
        body = Buffer.concat([body, buf.subarray(4, 4 + n)]);
        buf = buf.subarray(4 + n);
      }
    });
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, port: (server.address() as AddressInfo).port, received: () => total }),
    ),
  );
}

describe('clamd INSTREAM client (L-2)', () => {
  it('streams the whole file and maps OK / FOUND', async () => {
    const c = await fakeClamd();
    const av = createClamdScanner({ host: '127.0.0.1', port: c.port });
    expect(await av.scanFile(f)).toEqual({ infected: false });
    expect(c.received()).toBe(200_000);
    const bad = path.join(root, 'eicar.bin');
    writeFileSync(bad, Buffer.from('xxEICARxx'));
    expect(await av.scanFile(bad)).toEqual({ infected: true, signature: 'Eicar-Test-Signature' });
    c.server.close();
  });

  it('is fail-closed: unreachable clamd throws', async () => {
    const c = await fakeClamd();
    const port = c.port;
    await new Promise((r) => c.server.close(r));
    await expect(createClamdScanner({ host: '127.0.0.1', port }).scanFile(f)).rejects.toThrow(
      /unreachable/,
    );
  });

  it('is off unless UPLOAD_SCAN_CLAMAV=true', () => {
    expect(antivirusFromEnv({})).toBeUndefined();
    expect(antivirusFromEnv({ UPLOAD_SCAN_CLAMAV: 'false' })).toBeUndefined();
    expect(antivirusFromEnv({ UPLOAD_SCAN_CLAMAV: 'true' })).toBeDefined();
    expect(() => antivirusFromEnv({ UPLOAD_SCAN_CLAMAV: 'true', CLAMD_PORT: 'x' })).toThrow();
  });
});

/**
 * Scripted clamd: reads the zINSTREAM header, then answers `reply` either right away (`early`, as clamd does when a
 * stream passes StreamMaxLength) or after the terminating zero-length chunk. `reply: null` never answers.
 */
function scriptedClamd(reply: string | null, opts: { early?: boolean } = {}) {
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let header = false;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!header) {
        const i = buf.indexOf(0);
        if (i < 0) return;
        buf = buf.subarray(i + 1);
        header = true;
        if (opts.early && reply !== null) return void sock.end(reply);
      }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          if (reply !== null) sock.end(reply);
          return;
        }
        if (buf.length < 4 + n) return;
        buf = buf.subarray(4 + n);
      }
    });
  });
  return new Promise<{ server: Server; port: number }>((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

/** Opens the real file but keeps the stream, so a test can check the client destroyed it. */
function trackedIo() {
  const opened: ReadStream[] = [];
  return {
    opened,
    io: {
      openFile: (file: string) => {
        const s = createReadStream(file, { highWaterMark: 64 * 1024 });
        opened.push(s);
        return s;
      },
    },
  };
}

describe('clamd client is fail-closed on every non-clean outcome (#377 R1)', () => {
  const big = path.join(root, 'big.bin');
  writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 1));

  async function scan(
    reply: string | null,
    o: { early?: boolean; timeoutMs?: number; file?: string } = {},
  ) {
    const c = await scriptedClamd(reply, o);
    const t = trackedIo();
    const av = createClamdScanner(
      { host: '127.0.0.1', port: c.port, timeoutMs: o.timeoutMs ?? 5_000 },
      t.io,
    );
    try {
      const res = await av.scanFile(o.file ?? f).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      return { res, opened: t.opened };
    } finally {
      c.server.close();
    }
  }

  it('the clean reply is exact', async () => {
    expect(CLAMD_CLEAN_REPLY).toBe('stream: OK\0');
    const { res, opened } = await scan('stream: OK\0');
    expect(res).toEqual({ ok: true, v: { infected: false } });
    expect(opened[0]!.destroyed).toBe(true);
  });

  it('a Heuristics.Limits.Exceeded.* reply is never clean and is flagged limitExceeded (MAL-2)', async () => {
    for (const sig of ['MaxFileSize', 'MaxScanSize', 'MaxScanTime', 'MaxRecursion', 'MaxFiles']) {
      const { res, opened } = await scan(`stream: Heuristics.Limits.Exceeded.${sig} FOUND\0`);
      expect(res).toEqual({
        ok: true,
        v: { infected: true, signature: `Heuristics.Limits.Exceeded.${sig}`, limitExceeded: true },
      });
      expect(opened[0]!.destroyed).toBe(true);
    }
  });

  it.each([
    ['INSTREAM size limit exceeded. ERROR\0', true],
    ['INSTREAM size limit exceeded. ERROR\0', false],
    ["stream: Can't allocate memory ERROR\0", false],
    ['UNKNOWN COMMAND\0', false],
  ])('an ERROR reply (%j, early=%s) rejects with ClamdError', async (reply, early) => {
    const { res, opened } = await scan(reply, { early, file: big });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.e).toBeInstanceOf(ClamdError);
    expect(opened[0]!.destroyed).toBe(true);
  });

  it.each([
    'stream: OK',
    'stream: OK\n',
    ' stream: OK\0',
    'stream: OK \0',
    'stream: OK\0\0',
    'stream: OK\0stream: Eicar FOUND\0',
    'xstream: OK\0',
    'stream: OKAY\0',
    'STREAM: OK\0',
    '1: stream: OK\0',
    '',
  ])('a loose or partial clean reply (%j) is not clean', async (reply) => {
    const { res } = await scan(reply);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.e).toBeInstanceOf(ClamdError);
  });

  it('a clamd that never replies times out with ClamdError, and the stream is destroyed', async () => {
    const { res, opened } = await scan(null, { timeoutMs: 200, file: big });
    expect(res.ok).toBe(false);
    expect(!res.ok && (res.e as Error).message).toBe('clamd timeout');
    expect(!res.ok && res.e).toBeInstanceOf(ClamdError);
    expect(opened[0]!.destroyed).toBe(true);
  });

  it('a file read error rejects with ClamdError even if clamd would answer OK', async () => {
    const { res } = await scan('stream: OK\0', { file: path.join(root, 'missing.bin') });
    expect(res.ok).toBe(false);
    expect(!res.ok && (res.e as Error).message).toBe('read failed');
  });

  it('a file that cannot be opened at all rejects with ClamdError', async () => {
    const c = await scriptedClamd('stream: OK\0');
    const av = createClamdScanner(
      { host: '127.0.0.1', port: c.port, timeoutMs: 5_000 },
      {
        openFile: () => {
          throw new Error('EMFILE');
        },
      },
    );
    await expect(av.scanFile(f)).rejects.toBeInstanceOf(ClamdError);
    c.server.close();
  });
});
