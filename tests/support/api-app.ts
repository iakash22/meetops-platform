import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixturePassword } from './fixture-secrets.js';

/**
 * Auth/orgs API under test. Defaults to this repo's own apps/api (auth/orgs from PR #27 are on
 * integration/phase-1), so the AU/XT suites run in CI. QA_API_DIR overrides it with another
 * checkout. The suites skip only when the target has no auth module.
 */
export const apiDir = resolve(
  process.env.QA_API_DIR ?? fileURLToPath(new URL('../../apps/api', import.meta.url)),
);
export const hasAuthApi = existsSync(join(apiDir, 'src/modules/auth/http/auth.plugin.ts'));

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

const imp = (rel: string) => import(pathToFileURL(join(apiDir, rel)).href);

/** Mailer per app, so signupAndLogin can read the verification token. */
const mailers = new WeakMap<InjectApp, Mailer>();

export async function buildAuthApp(deps: Record<string, unknown> = {}) {
  const { createServer } = (await imp('src/server.ts')) as {
    createServer: (o: { deps: Record<string, unknown> }) => InjectApp;
  };
  const { RecordingAuthMailer } = (await imp('src/modules/auth/domain/mailer.ts')) as {
    RecordingAuthMailer: new () => Mailer;
  };
  const clock = new FakeClock();
  const mailer = new RecordingAuthMailer();
  const app = createServer({
    // No-op sleep: the login lockout's progressive delay would otherwise really wait.
    deps: { mailer, hasher: fakeHasher, clock, sleep: async () => {}, ...deps },
  });
  mailers.set(app, mailer);
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
    return this.mutate('POST', url, payload, headers);
  }
  async patch(url: string, payload?: object, headers: Record<string, string> = {}) {
    return this.mutate('PATCH', url, payload, headers);
  }
  async delete(url: string, headers: Record<string, string> = {}) {
    return this.mutate('DELETE', url, undefined, headers);
  }
  /** State-changing request with Origin + double-submit CSRF, like the web app. */
  async mutate(
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) {
    if (!this.jar.has(CSRF)) await this.csrf();
    return this.absorb(
      await this.app.inject({
        method,
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
  // D2: verify the email first (org create/invite/accept require a verified account).
  const to = email.toLowerCase();
  const token = [...(mailers.get(app)?.sent ?? [])]
    .reverse()
    .find((m) => m.kind === 'verify' && m.to === to)?.token;
  if (!token) throw new Error('signup sent no verification token');
  const v = await c.post('/auth/verify-email', { token });
  if (v.statusCode !== 204) throw new Error(`verify-email ${v.statusCode}`);
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
