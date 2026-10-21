/* eslint-disable @typescript-eslint/no-unsafe-argument -- test/ is not part of a TS project (see report) */
import { createServer } from '../src/server';
import type { ModuleDeps } from '../src/modules/index';
import { RecordingAuthMailer } from '../src/modules/auth/domain/mailer';
import type { PasswordHasher } from '../src/modules/auth/domain/ports';

export const ORIGIN = 'http://localhost:5173';
export const SID = '__Host-meetops_sid';
export const CSRF = '__Host-meetops_csrf';
export const PASSWORD = 'correct-horse-battery';

/** Fast deterministic hasher for tests that are not about argon2. */
export const fakeHasher: PasswordHasher = {
  hash: async (p) => `fake$${p}`,
  verify: async (h, p) => h === `fake$${p}`,
  needsRehash: () => false
};

export async function buildApp(deps: Partial<ModuleDeps> = {}) {
  const mailer = new RecordingAuthMailer();
  const app = createServer({ deps: { mailer, hasher: fakeHasher, ...deps } });
  await app.ready();
  return Object.assign(app, { mailer });
}
export type App = Awaited<ReturnType<typeof buildApp>>;

type Res = Awaited<ReturnType<App['inject']>>;

/** Cookie-jar client that behaves like the web app: Origin + double-submit CSRF. */
export class Client {
  jar = new Map<string, string>();
  constructor(private readonly app: App) {}

  absorb(res: Res) {
    for (const c of res.cookies) {
      if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) this.jar.delete(c.name);
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
    return this.absorb(await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookie } }));
  }
  async post(url: string, payload?: object, headers: Record<string, string> = {}) {
    if (!this.jar.has(CSRF)) await this.csrf();
    return this.absorb(
      await this.app.inject({
        method: 'POST',
        url,
        ...(payload ? { payload } : {}),
        headers: { cookie: this.cookie, origin: ORIGIN, 'x-csrf-token': this.jar.get(CSRF)!, ...headers }
      })
    );
  }
}

export async function signupAndLogin(app: App, email: string, password = PASSWORD) {
  const c = new Client(app);
  const s = await c.post('/auth/signup', { name: 'Test User', email, password });
  if (s.statusCode !== 202) throw new Error(`signup ${s.statusCode} ${s.body}`);
  const l = await c.post('/auth/login', { email, password });
  if (l.statusCode !== 200) throw new Error(`login ${l.statusCode} ${l.body}`);
  return c;
}
