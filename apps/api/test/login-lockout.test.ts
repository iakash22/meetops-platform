import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, Client, PASSWORD, signupAndLogin, type App } from './helpers.js';

const WRONG = 'definitely-not-it';
let apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function setup() {
  const delays: number[] = [];
  const app = await buildApp({ sleep: async (ms) => void delays.push(ms) });
  apps.push(app);
  return { app, delays };
}

async function failTen(app: App, email: string) {
  const c = new Client(app);
  const res = [];
  for (let i = 0; i < 10; i++) res.push(await c.post('/auth/login', { email, password: WRONG }));
  return res;
}

describe('login lockout (auth-session-spec §5)', () => {
  it('1-4 plain 401, 5-9 delayed 401 (never 429), 10th locks; correct password then rejected', async () => {
    const { app, delays } = await setup();
    await signupAndLogin(app, 'lock@example.test');
    const res = await failTen(app, 'lock@example.test');
    expect(res.map((r) => r.statusCode)).toEqual(Array(10).fill(401));
    expect(new Set(res.map((r) => r.json().error?.code ?? r.json().code)).size).toBe(1);
    expect(delays).toEqual([100, 200, 400, 800, 1000]);
    const locked = await new Client(app).post('/auth/login', {
      email: 'lock@example.test',
      password: PASSWORD,
    });
    expect(locked.statusCode).toBe(429);
  });

  it('unknown email gets identical statuses, delays and lock (enumeration-safe)', async () => {
    const { app, delays } = await setup();
    const res = await failTen(app, 'ghost@example.test');
    expect(res.map((r) => r.statusCode)).toEqual(Array(10).fill(401));
    expect(delays).toEqual([100, 200, 400, 800, 1000]);
    const locked = await new Client(app).post('/auth/login', {
      email: 'ghost@example.test',
      password: PASSWORD,
    });
    expect(locked.statusCode).toBe(429);
  });
});
