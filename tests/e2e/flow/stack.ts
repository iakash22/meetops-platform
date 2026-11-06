/**
 * Test-only stack for the web E2E flow (no product code changes):
 *  - API: `createServer()` from QA_API_DIR (built `dist/`), in-memory deps (NODE_ENV=test).
 *  - Web: QA_WEB_DIR built `dist/` (VITE_API_URL unset, so the app calls same-origin `/api`).
 *  - A tiny same-origin proxy serves the SPA and forwards `/api/*` to the API (prefix stripped),
 *    which is what the web app expects in production behind a reverse proxy.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const apiDir = process.env.QA_API_DIR ? resolve(process.env.QA_API_DIR) : undefined;
export const webDir = process.env.QA_WEB_DIR ? resolve(process.env.QA_WEB_DIR) : undefined;

const apiEntry = apiDir ? join(apiDir, 'dist', 'index.js') : undefined;
const webDist = webDir ? join(webDir, 'dist') : undefined;

/** Why the flow suite cannot run here, or undefined when it can. */
export function flowSkipReason(): string | undefined {
  if (!apiEntry || !webDist) return 'QA_API_DIR and QA_WEB_DIR must point at external checkouts';
  if (!existsSync(apiEntry))
    return `API not built: ${apiEntry} missing (pnpm --filter @meetops/api... build)`;
  if (!existsSync(join(webDist, 'index.html')))
    return `web not built: ${webDist}/index.html missing (vite build in QA_WEB_DIR)`;
  return undefined;
}

type RecordedMailer = { sent: { kind: string; to: string; token?: string }[] };

type ApiApp = {
  listen(o: { port: number; host: string }): Promise<string>;
  close(): Promise<void>;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function listen(server: Server): Promise<number> {
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)),
  );
}

export class Stack {
  private api: ApiApp | undefined;
  private mailer: RecordedMailer | undefined;
  private apiPort = 0;
  private proxy?: Server;
  origin = '';
  /** Extra API deps (merged over the recording mailer), e.g. shared in-memory repositories for a suite. */
  constructor(private readonly extraDeps: Record<string, unknown> = {}) {}

  async start(): Promise<void> {
    this.proxy = createHttpServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/api' || url.startsWith('/api/')) {
        const upstream = httpRequest(
          {
            host: '127.0.0.1',
            port: this.apiPort,
            method: req.method,
            path: url.slice(4) || '/',
            headers: { ...req.headers, host: `127.0.0.1:${this.apiPort}` },
          },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('bad gateway');
        });
        req.pipe(upstream);
        return;
      }
      const path = normalize(decodeURIComponent(url.split('?')[0] ?? '/')).replace(
        /^(\.\.[/\\])+/,
        '',
      );
      let file = join(webDist!, path);
      if (!file.startsWith(webDist!) || !existsSync(file) || statSync(file).isDirectory())
        file = join(webDist!, 'index.html'); // SPA fallback
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    const proxyPort = await listen(this.proxy);
    // localhost (not 127.0.0.1) so Chromium treats it as a secure context for __Host- cookies.
    this.origin = `http://localhost:${proxyPort}`;
    await this.startApi();
  }

  async startApi(): Promise<void> {
    process.env.NODE_ENV = 'test';
    process.env.WEB_ORIGINS = this.origin;
    process.env.LOG_LEVEL ??= 'silent';
    const mod = (await import(pathToFileURL(apiEntry!).href)) as {
      createServer: (o?: { nodeEnv?: string; deps?: Record<string, unknown> }) => ApiApp;
    };
    if (!this.mailer) {
      // D2 (PR #53): org create/invite need a verified email; record mail to read the token.
      const { RecordingAuthMailer } = (await import(
        pathToFileURL(join(apiDir!, 'dist', 'modules', 'auth', 'domain', 'mailer.js')).href
      )) as { RecordingAuthMailer: new () => RecordedMailer };
      this.mailer = new RecordingAuthMailer();
    }
    this.api = mod.createServer({
      nodeEnv: 'test',
      deps: { ...this.extraDeps, mailer: this.mailer },
    });
    const address = await this.api.listen({ port: this.apiPort, host: '127.0.0.1' });
    this.apiPort = Number(new URL(address).port);
  }

  /** Latest email-verification token sent to `email` (waits briefly for async mail jobs). */
  async verificationToken(email: string): Promise<string> {
    const to = email.toLowerCase();
    for (let i = 0; i < 50; i++) {
      const token = [...(this.mailer?.sent ?? [])]
        .reverse()
        .find((m) => m.kind === 'verify' && m.to === to)?.token;
      if (token) return token;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no verification email recorded for ${to}`);
  }

  /** Stop the API process-side; the proxy keeps serving the SPA and answers /api with 502. */
  async stopApi(): Promise<void> {
    await this.api?.close();
    this.api = undefined;
  }

  async stop(): Promise<void> {
    await this.stopApi();
    await new Promise<void>((ok) => (this.proxy ? this.proxy.close(() => ok()) : ok()));
  }
}
