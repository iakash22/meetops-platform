/* eslint-disable @typescript-eslint/no-unsafe-argument -- test/ is not part of a TS project (see report) */
import { createServer } from '../src/server';
import type { ModuleDeps } from '../src/modules/index';

export async function buildApp(deps: Partial<ModuleDeps> = {}) {
  const app = createServer({ deps });
  await app.ready();
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((x) => x.name === 'meetops_session');
  if (!c) throw new Error('no session cookie');
  return `meetops_session=${c.value}`;
}

export async function signup(app: App, email: string, password = 'correct-horse-battery') {
  const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password } });
  return { res, cookie: sessionCookie(res) };
}
