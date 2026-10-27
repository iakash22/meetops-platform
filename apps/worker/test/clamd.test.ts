import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { antivirusFromEnv, createClamdScanner } from '../src/media/clamd.js';

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
