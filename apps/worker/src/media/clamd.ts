import { createReadStream, type ReadStream } from 'node:fs';
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
  const flag = env.UPLOAD_SCAN_CLAMAV?.trim();
  if (flag && flag !== 'true' && flag !== 'false')
    throw new Error('UPLOAD_SCAN_CLAMAV must be "true" or "false"');
  if (flag !== 'true') return undefined;
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

/**
 * The exact clean reply to `zINSTREAM`: clamd NUL-terminates every reply in z mode. Anything else, including extra
 * text, whitespace or a second line around it, is not clean (fail-closed).
 */
export const CLAMD_CLEAN_REPLY = 'stream: OK\0';
/** `stream: <signature> FOUND\0`, one line, nothing before or after. Includes Heuristics.Limits.Exceeded.*. */
const FOUND_REPLY = /^stream: ([^\0\r\n]{1,200}) FOUND\0$/;

/** Test seam: how the upload file is opened (defaults to node:fs createReadStream). */
export type ClamdIo = { openFile?: (file: string) => ReadStream };

/**
 * clamd `zINSTREAM` client. Fail-closed: only the exact {@link CLAMD_CLEAN_REPLY} is clean; an ERROR reply (for
 * example `INSTREAM size limit exceeded. ERROR`), an empty, malformed or oversized reply, a timeout, a socket error
 * or a file read error all reject with {@link ClamdError}. The file stream and the socket are destroyed on every
 * path. Today `timeoutMs` is one fixed total deadline (default 120 s, below clamd's MaxScanTime of 600 s); MAL-2
 * makes it size-aware.
 */
export function createClamdScanner(cfg: ClamdConfig, io: ClamdIo = {}): Antivirus {
  const timeoutMs = cfg.timeoutMs ?? 120_000;
  const openFile =
    io.openFile ?? ((file: string) => createReadStream(file, { highWaterMark: 64 * 1024 }));
  return {
    scanFile: (file) =>
      new Promise<AntivirusVerdict>((resolve, reject) => {
        const sock: Socket =
          'socketPath' in cfg ? connect(cfg.socketPath) : connect(cfg.port, cfg.host);
        let src: ReadStream | undefined;
        let reply = '';
        let done = false;
        const finish = (err: Error | null, v?: AntivirusVerdict) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          src?.destroy();
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
          if (reply === CLAMD_CLEAN_REPLY) return finish(null, { infected: false });
          const m = FOUND_REPLY.exec(reply);
          if (m) return finish(null, { infected: true, signature: m[1]! });
          finish(new ClamdError('clamd error reply'));
        });
        sock.on('close', () => finish(new ClamdError('clamd closed without a reply')));
        sock.on('connect', () => {
          if (done) return;
          sock.write('zINSTREAM\0');
          try {
            src = openFile(file);
          } catch {
            return finish(new ClamdError('read failed'));
          }
          src.on('data', (chunk) => {
            if (done) return;
            const b = chunk as Buffer;
            const len = Buffer.alloc(4);
            len.writeUInt32BE(b.length, 0);
            if (!sock.write(Buffer.concat([len, b]))) {
              src!.pause();
              sock.once('drain', () => {
                if (!done) src!.resume();
              });
            }
          });
          src.on('error', () => finish(new ClamdError('read failed')));
          src.on('end', () => {
            if (!done) sock.write(Buffer.alloc(4));
          });
        });
      }),
  };
}
