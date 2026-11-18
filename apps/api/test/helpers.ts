import type { FastifyInstance } from 'fastify';
import { createServer } from '../src/server.js';
import type { ModuleDeps } from '../src/modules/index.js';
import {
  RecordingMailTransport,
  type AuthMailTemplate,
} from '../src/modules/auth/domain/mail-jobs.js';
import type { PasswordHasher } from '../src/modules/auth/domain/ports.js';

export const ORIGIN = 'http://localhost:5173';
export const SID = '__Host-meetops_sid';
export const CSRF = '__Host-meetops_csrf';
export const PASSWORD = 'correct-horse-battery-1';

/** Fast deterministic hasher for tests that are not about argon2. */
export const fakeHasher: PasswordHasher = {
  hash: async (p) => `fake$${p}`,
  verify: async (h, p) => h === `fake$${p}`,
  needsRehash: () => false,
};

/** Not thenable on purpose, so async helpers can return it without TS unwrapping it. */
export type App = Omit<FastifyInstance, 'then'> & {
  mail: RecordingMailTransport;
  token(to: string, t: AuthMailTemplate): string | undefined;
};

export async function buildApp(
  deps: Partial<ModuleDeps> = {},
  opts: { logStream?: { write(line: string): void } } = {},
): Promise<App> {
  const mail = new RecordingMailTransport();
  const app = createServer({
    deps: { hasher: fakeHasher, ...deps, mailTransport: mail },
    ...(opts.logStream ? { logStream: opts.logStream } : {}),
  });
  await app.ready();
  const out = Object.assign(app, {
    mail,
    token: (to: string, t: AuthMailTemplate) => mail.lastToken(to, t),
  });
  // App omits `then`, so TS does not unwrap the thenable Fastify instance and drop the extras.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- tsc needs it (thenable)
  return out as unknown as App;
}

type Res = Awaited<ReturnType<App['inject']>>;

/** Cookie-jar client that behaves like the web app: Origin + double-submit CSRF. */
export class Client {
  jar = new Map<string, string>();
  constructor(private readonly app: App) {}

  absorb(res: Res) {
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
    const res = this.absorb(await this.app.inject({ method: 'GET', url: '/auth/csrf' }));
    return res.json().csrfToken as string;
  }
  async get(url: string) {
    return this.absorb(
      await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookie } }),
    );
  }
  post(url: string, payload?: object, headers: Record<string, string> = {}) {
    return this.send('POST', url, payload, headers);
  }
  patch(url: string, payload?: object) {
    return this.send('PATCH', url, payload);
  }
  put(url: string, payload?: object) {
    return this.send('PUT', url, payload);
  }
  delete(url: string) {
    return this.send('DELETE', url);
  }
  async send(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) {
    if (!this.jar.has(CSRF)) await this.csrf();
    return this.absorb(
      await this.app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: {
          cookie: this.cookie,
          origin: ORIGIN,
          'x-csrf-token': this.jar.get(CSRF)!,
          ...headers,
        },
      }),
    );
  }
}

export async function signupAndLogin(
  app: App,
  email: string,
  password = PASSWORD,
  opts: { verify?: boolean } = {},
) {
  const c = new Client(app);
  const s = await c.post('/auth/signup', { name: 'Test User', email, password });
  if (s.statusCode !== 202) throw new Error(`signup ${s.statusCode} ${s.body}`);
  if (opts.verify !== false) {
    const v = await c.post('/auth/verify-email', {
      token: app.token(email.toLowerCase(), 'email_verification')!,
    });
    if (v.statusCode !== 204) throw new Error(`verify ${v.statusCode} ${v.body}`);
  }
  const l = await c.post('/auth/login', { email, password });
  if (l.statusCode !== 200) throw new Error(`login ${l.statusCode} ${l.body}`);
  return c;
}
