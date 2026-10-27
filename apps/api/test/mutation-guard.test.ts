import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryTasks } from '../src/modules/tasks/in-memory.repository.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, CSRF, ORIGIN, signupAndLogin, type App, type Client } from './helpers.js';

const ID = '00000000-0000-4000-8000-0000000004a1';

/** Security C / PR #261 HIGH: every mutating tasks + projects route must reject missing CSRF and foreign Origin. */
describe('mutation guard (CSRF + Origin) on tasks and projects routes', () => {
  let app: App;
  let owner: Client;
  let org: string;
  beforeEach(async () => {
    app = await buildApp({ tasks: new InMemoryTasks() } as Partial<ModuleDeps>);
    owner = await signupAndLogin(app, 'owner@example.com');
    org = (await owner.post('/orgs', { name: 'Acme' })).json<{ organization: { id: string } }>()
      .organization.id;
  });
  afterEach(async () => app.close());

  const routes = (): Array<[method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: object]> => [
    ['POST', `/orgs/${org}/tasks`, { title: 'x' }],
    ['PATCH', `/orgs/${org}/tasks/${ID}`, { title: 'y' }],
    ['POST', `/orgs/${org}/extracted-tasks/${ID}/accept`, {}],
    ['POST', `/orgs/${org}/extracted-tasks/${ID}/dismiss`],
    ['POST', `/orgs/${org}/projects`, { name: 'P', key: 'PRJ' }],
    ['PATCH', `/orgs/${org}/projects/${ID}`, { name: 'Q' }],
    ['DELETE', `/orgs/${org}/projects/${ID}`],
  ];

  const send = (
    method: string,
    url: string,
    body: object | undefined,
    headers: Record<string, string>,
  ) =>
    app.inject({
      method: method as 'POST',
      url,
      ...(body ? { payload: body } : {}),
      headers: { cookie: owner.cookie, ...headers },
    });

  it('403 without an X-CSRF-Token', async () => {
    for (const [m, url, body] of routes()) {
      const r = await send(m, url, body, { origin: ORIGIN });
      expect(r.statusCode, `${m} ${url}`).toBe(403);
    }
  });

  it('403 with a foreign Origin even with a valid CSRF token', async () => {
    const token = owner.jar.get(CSRF)!;
    expect(token).toBeTruthy();
    for (const [m, url, body] of routes()) {
      const r = await send(m, url, body, { origin: 'https://evil.example', 'x-csrf-token': token });
      expect(r.statusCode, `${m} ${url}`).toBe(403);
    }
  });

  it('control: the same client passes the guard with Origin + CSRF', async () => {
    const r = await owner.post(`/orgs/${org}/tasks`, { title: 'ok' });
    expect(r.statusCode).toBe(201);
  });
});
