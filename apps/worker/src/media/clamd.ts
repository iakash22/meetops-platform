import { createReadStream } from 'node:fs';
import { connect, type Socket } from 'node:net';

/**
 * Optional ClamAV step (PR #274 L-2) via a local clamd (`INSTREAM`). Off by default; when enabled it is fail-closed:
 * an unreachable/erroring clamd throws, so the job retries and the final attempt quarantines the upload.
 */
export type AntivirusVerdict = { infected: false } | { infected: true; signature: string };
export type Antivirus = { scanFile(file: string): Promise<AntivirusVerdict> };

export type ClamdConfig =
  { host: string; port: number; timeoutMs?: number } | { socketPath: string; timeoutMs?: number };

/** Upload scan antivirus from env: UPLOAD_SCAN_CLAMAV=true + CLAMD_SOCKET or CLAMD_HOST/CLAMD_PORT. */
export function antivirusFromEnv(env: NodeJS.ProcessEnv = process.env): Antivirus | undefined {
  if (env.UPLOAD_SCAN_CLAMAV !== 'true') return undefined;
  if (env.CLAMD_SOCKET) return createClamdScanner({ socketPath: env.CLAMD_SOCKET });
  const port = Number(env.CLAMD_PORT ?? 3310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CLAMD_PORT');
  return createClamdScanner({ host: env.CLAMD_HOST ?? '127.0.0.1', port });
}

export class ClamdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClamdError';
  }
}

export function createClamdScanner(cfg: ClamdConfig): Antivirus {
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  return {
    scanFile: (file) =>
      new Promise<AntivirusVerdict>((resolve, reject) => {
        const sock: Socket =
          'socketPath' in cfg ? connect(cfg.socketPath) : connect(cfg.port, cfg.host);
        let reply = '';
        let done = false;
        const finish = (err: Error | null, v?: AntivirusVerdict) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sock.destroy();
          if (err) reject(err);
          else resolve(v!);
        };
        const timer = setTimeout(() => finish(new ClamdError('clamd timeout')), timeoutMs);
        sock.on('error', () => finish(new ClamdError('clamd unreachable')));
        sock.on('data', (d: Buffer) => {
          reply += d.toString('utf8');
          if (reply.length > 4096) finish(new ClamdError('clamd reply too long'));
        });
        sock.on('end', () => {
          const r = reply.replace(/\0/g, '').trim();
          if (/^stream: OK$/.test(r)) return finish(null, { infected: false });
          const m = /^stream: (.{1,200}) FOUND$/.exec(r);
          if (m) return finish(null, { infected: true, signature: m[1]! });
          finish(new ClamdError('clamd error reply'));
        });
        sock.on('connect', () => {
          sock.write('zINSTREAM\0');
          const src = createReadStream(file, { highWaterMark: 64 * 1024 });
          src.on('data', (chunk) => {
            const b = chunk as Buffer;
            const len = Buffer.alloc(4);
            len.writeUInt32BE(b.length, 0);
            if (!sock.write(Buffer.concat([len, b]))) {
              src.pause();
              sock.once('drain', () => src.resume());
            }
          });
          src.on('error', () => finish(new ClamdError('read failed')));
          src.on('end', () => sock.write(Buffer.alloc(4)));
        });
      }),
  };
}
