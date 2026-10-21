import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixturePassword } from './fixture-secrets.js';

/**
 * Backend's auth/orgs API (PR #27, feat/api-auth-orgs). Point QA_API_DIR at that branch's
 * apps/api (read-only worktree). Suites skip when it is unset or has no auth module.
 */
export const apiDir = process.env.QA_API_DIR ? resolve(process.env.QA_API_DIR) : undefined;
export const hasAuthApi =
  !!apiDir && existsSync(join(apiDir, 'src/modules/auth/http/auth.plugin.ts'));

export type InjectResponse = {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
  cookies: { name: string; value: string; expires?: Date; [k: string]: unknown }[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted per test
  json: () => any;
};
export type InjectApp = {
  inject: (opts: {
    method: string;
    url: string;
    payload?: object;
    headers?: Record<string, string>;
    remoteAddress?: string;
  }) => Promise<InjectResponse>;
  ready: () => Promise<unknown>;
  close: () => Promise<unknown>;
};
export type Sent = { kind: string; to: string; token?: string };
export type Mailer = { sent: Sent[] };

/** Mutable clock so expiry/timeout cases run without waiting. */
export class FakeClock {
  t = Date.parse('2026-10-21T10:00:00.000Z');
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

/** Fast deterministic hasher (tests/ only) for cases that are not about argon2. */
export const fakeHasher = {
  hash: async (p: string) => `fake$${p}`,
  verify: async (h: string, p: string) => h === `fake$${p}`,
  needsRehash: () => false,
};

const imp = (rel: string) => import(pathToFileURL(join(apiDir ?? '', rel)).href);

export async function buildAuthApp(deps: Record<string, unknown> = {}) {
  const { createServer } = (await imp('src/server.ts')) as {
    createServer: (o: { deps: Record<string, unknown> }) => InjectApp;
  };
  const { RecordingAuthMailer } = (await imp('src/modules/auth/domain/mailer.ts')) as {
    RecordingAuthMailer: new () => Mailer;
  };
  const clock = new FakeClock();
  const mailer = new RecordingAuthMailer();
  const app = createServer({ deps: { mailer, hasher: fakeHasher, clock, ...deps } });
  await app.ready();
  return { app, mailer, clock };
}

export const ORIGIN = 'http://localhost:3000';
export const SID = '__Host-meetops_sid';
export const CSRF = '__Host-meetops_csrf';
export const PASSWORD = fixturePassword('correct');

/** Cookie-jar client that behaves like the web app: Origin + double-submit CSRF. */
export class Client {
  jar = new Map<string, string>();
  constructor(
    private readonly app: InjectApp,
    readonly ip = '203.0.113.10',
  ) {}

  absorb(res: InjectResponse) {
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now()))
        this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
    return res;
  }
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async csrf() {
    const res = this.absorb(
      await this.app.inject({ method: 'GET', url: '/auth/csrf', remoteAddress: this.ip }),
    );
    return res.json().csrfToken as string;
  }
  async get(url: string) {
    return this.absorb(
      await this.app.inject({
        method: 'GET',
        url,
        headers: { cookie: this.cookie },
        remoteAddress: this.ip,
      }),
    );
  }
  async post(url: string, payload?: object, headers: Record<string, string> = {}) {
    if (!this.jar.has(CSRF)) await this.csrf();
    return this.absorb(
      await this.app.inject({
        method: 'POST',
        url,
        remoteAddress: this.ip,
        ...(payload ? { payload } : {}),
        headers: {
          cookie: this.cookie,
          origin: ORIGIN,
          'x-csrf-token': this.jar.get(CSRF) ?? '',
          ...headers,
        },
      }),
    );
  }
}

export async function signupAndLogin(app: InjectApp, email: string, ip?: string) {
  const c = new Client(app, ip);
  const s = await c.post('/auth/signup', { name: 'QA User', email, password: PASSWORD });
  if (s.statusCode !== 202) throw new Error(`signup ${s.statusCode} ${s.body}`);
  const l = await c.post('/auth/login', { email, password: PASSWORD });
  if (l.statusCode !== 200) throw new Error(`login ${l.statusCode} ${l.body}`);
  return c;
}

/** Error code from either `{ error: { code } }` or `{ code }` bodies. */
export function errorCode(res: InjectResponse): string | undefined {
  const b = res.json() as { code?: string; error?: { code?: string } };
  return b.error?.code ?? b.code;
}

/** Response body without the per-request `requestId`, for "same body" comparisons. */
export function comparableBody(res: InjectResponse): unknown {
  return JSON.parse(res.body, (k, v: unknown) => (k === 'requestId' ? undefined : v));
}
