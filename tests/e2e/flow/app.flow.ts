import {
  expect,
  request as pwRequest,
  test as base,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { fixturePassword } from '../../support/fixture-secrets.js';
import { flowSkipReason, Stack } from './stack.js';

const skipReason = flowSkipReason();

type Fixtures = { stack: Stack; api: Api };

/** API client for test setup (same origin as the web app, through the proxy). */
class Api {
  constructor(
    readonly ctx: APIRequestContext,
    readonly origin: string,
    readonly stack: Stack,
  ) {}
  private async csrf(): Promise<string> {
    const r = await this.ctx.get('/api/auth/csrf');
    expect(r.status(), 'GET /auth/csrf').toBe(200);
    return ((await r.json()) as { csrfToken: string }).csrfToken;
  }
  async post(path: string, data: unknown, withCsrf = true) {
    const headers: Record<string, string> = { origin: this.origin };
    if (withCsrf) headers['x-csrf-token'] = await this.csrf();
    return this.ctx.post(`/api${path}`, { data, headers });
  }
  async signup(email: string, password: string) {
    const r = await this.post('/auth/signup', { name: 'QA E2E', email, password });
    expect([200, 201, 202], `signup status ${r.status()}`).toContain(r.status());
    // D2 (PR #53): verify the email so org create/switch work for this user.
    const token = await this.stack.verificationToken(email);
    const v = await this.post('/auth/verify-email', { token });
    expect(v.status(), 'verify-email').toBe(204);
  }
  async login(email: string, password: string) {
    const r = await this.post('/auth/login', { email, password });
    expect(r.status(), 'login').toBe(200);
  }
  async createOrg(name: string): Promise<{ id: string; name: string }> {
    const r = await this.post('/orgs', { name });
    expect(r.status(), `POST /orgs: ${await r.text()}`).toBe(201);
    return ((await r.json()) as { organization: { id: string; name: string } }).organization;
  }
}

const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  stack: async ({}, use) => {
    const s = new Stack();
    await s.start();
    await use(s);
    await s.stop();
  },
  api: async ({ stack }, use) => {
    const ctx = await pwRequest.newContext({ baseURL: stack.origin });
    await use(new Api(ctx, stack.origin, stack));
    await ctx.dispose();
  },
  baseURL: async ({ stack }, use) => use(stack.origin),
});

test.skip(!!skipReason, skipReason ?? '');

let n = 0;
const newEmail = () => `qa-e2e-${process.pid}-${Date.now()}-${n++}@example.test`;
const PASSWORD = fixturePassword('e2e');

/** Login form submit button (apps/web LoginForm: <SubmitButton>Log in</SubmitButton>). */
const loginButton = (page: Page) => page.getByRole('button', { name: 'Log in', exact: true });

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await loginButton(page).click();
}

/** User with `orgs` organizations created through the real API. */
async function seedUser(api: Api, orgNames: string[]) {
  const email = newEmail();
  await api.signup(email, PASSWORD);
  await api.login(email, PASSWORD);
  const orgs = [];
  for (const name of orgNames) orgs.push(await api.createOrg(name));
  return { email, orgs };
}

test.describe('web flow (PR #48 web + createServer API)', () => {
  test('[E2E-01] unauthenticated visit to /meetings redirects to /login?next=', async ({
    page,
  }) => {
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login\?next=%2Fmeetings/);
    await expect(loginButton(page)).toBeVisible();
  });

  test('[E2E-02] login with a real account lands in the app shell', async ({ page, api }) => {
    const { email } = await seedUser(api, ['Acme QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('[E2E-03] wrong password shows an error and stays on /login', async ({ page, api }) => {
    const { email } = await seedUser(api, []);
    await uiLogin(page, email, fixturePassword('e2e-wrong'));
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('[E2E-04] login honours a same-origin ?next= after the redirect', async ({ page, api }) => {
    const { email } = await seedUser(api, ['Next QA']);
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await loginButton(page).click();
    await expect(page).toHaveURL(/\/meetings$/);
  });

  /** Log in a user with two orgs, open /meetings, and return the switcher plus active/other orgs. */
  async function twoOrgSetup(page: Page, api: Api) {
    const { email, orgs } = await seedUser(api, ['Alpha QA', 'Beta QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    const switcher = page.getByRole('combobox', { name: 'Organization' });
    await expect(switcher).toHaveText(/Alpha QA|Beta QA/);
    const activeIdx = (await switcher.innerText()).includes('Alpha QA') ? 0 : 1;
    await page.goto('/meetings');
    await expect(page.getByRole('heading', { name: 'Meetings' })).toBeVisible();
    return { switcher, active: orgs[activeIdx]!, other: orgs[1 - activeIdx]! };
  }

  test('[E2E-05] org switcher switches via POST /orgs/switch and refetches the session', async ({
    page,
    api,
  }) => {
    // BE-GAP-2 (client side) resolved: the web client calls POST /orgs/switch, which returns
    // { organization, role } and rotates the session, then refetches GET /auth/session.
    const { switcher, other } = await twoOrgSetup(page, api);
    const switchResp = page.waitForResponse((r) => r.url().endsWith('/api/orgs/switch'));
    const sessionRefetch = page.waitForResponse(
      (r) => r.url().endsWith('/api/auth/session') && r.request().method() === 'GET',
    );
    await switcher.click();
    await expect(page.getByRole('option')).toHaveText(['Alpha QA', 'Beta QA']);
    await page.getByRole('option', { name: other.name }).click();
    const resp = await switchResp;
    expect(resp.request().postDataJSON()).toEqual({ organizationId: other.id });
    expect(resp.status()).toBe(200);
    expect((await sessionRefetch).status()).toBe(200);
    await expect(switcher).toContainText(other.name);
    await page.waitForRequest((r) => r.url().includes(`/api/orgs/${other.id}/meetings`));
  });

  test('[E2E-05b] a failed org switch keeps the current org (no cross-org requests)', async ({
    page,
    api,
  }) => {
    const { switcher, active, other } = await twoOrgSetup(page, api);
    const otherOrgRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(`/api/orgs/${other.id}/`)) otherOrgRequests.push(r.url());
    });
    // Force the switch to fail regardless of whether the endpoint exists.
    await page.route('**/api/orgs/switch', (route) =>
      route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } }),
    );
    const switchResp = page.waitForResponse((r) => r.url().endsWith('/api/orgs/switch'));
    await switcher.click();
    await page.getByRole('option', { name: other.name }).click();
    await switchResp;
    await expect(switcher).toContainText(active.name);
    await page.reload();
    await expect(switcher).toContainText(active.name);
    expect(otherOrgRequests).toEqual([]);
  });

  test('[E2E-06] user without organizations sees a disabled switcher', async ({ page, api }) => {
    const { email } = await seedUser(api, []);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Organization' })).toBeDisabled();
  });

  test('[E2E-07] create an organization from the empty dashboard', async ({ page, api }) => {
    const { email } = await seedUser(api, []);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: 'Create organization' }).click();
    await expect(page).toHaveURL(/\/organizations\/new$/);
    await page.getByLabel('Organization name').fill('Created QA');
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(page).not.toHaveURL(/\/organizations\/new/);
    const switcher = page.getByRole('combobox', { name: 'Organization' });
    await expect(switcher).toBeEnabled();
    await expect(switcher).toContainText('Created QA');
    // Persisted server-side: a reload rebuilds the switcher from GET /auth/session.
    await page.reload();
    await expect(switcher).toContainText('Created QA');
  });

  test('[E2E-07b] create a second organization from the switcher link', async ({ page, api }) => {
    const { email } = await seedUser(api, ['First QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.getByRole('link', { name: 'Create organization' }).first().click();
    await expect(page).toHaveURL(/\/organizations\/new$/);
    await page.getByLabel('Organization name').fill('Second QA');
    await page.getByRole('button', { name: 'Create organization' }).click();
    const switcher = page.getByRole('combobox', { name: 'Organization' });
    await expect(switcher).toContainText('Second QA');
    await switcher.click();
    await expect(page.getByRole('option')).toHaveText(['First QA', 'Second QA']);
  });

  test('[E2E-07c] empty organization name is rejected client-side', async ({ page, api }) => {
    const { email } = await seedUser(api, []);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.goto('/organizations/new');
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/orgs')) posts.push(r.url());
    });
    await page.getByRole('button', { name: 'Create organization' }).click();
    await expect(page.getByText('Organization name is required')).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  test('[E2E-08] meetings list renders contract-shaped data (meetings API stubbed in tests/)', async ({
    page,
    api,
  }) => {
    const { email, orgs } = await seedUser(api, ['Meet QA']);
    const org = orgs[0]!;
    const T = new Date().toISOString();
    await page.route(`**/api/orgs/${org.id}/meetings`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: crypto.randomUUID(),
              organizationId: org.id,
              title: 'Weekly sync QA',
              source: 'upload',
              status: 'completed',
              startedAt: T,
              endedAt: T,
              createdById: crypto.randomUUID(),
              createdAt: T,
              updatedAt: T,
            },
            {
              id: crypto.randomUUID(),
              organizationId: org.id,
              title: 'Planning QA',
              source: 'extension',
              status: 'recording',
              startedAt: T,
              createdById: crypto.randomUUID(),
              createdAt: T,
              updatedAt: T,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.goto('/meetings');
    await expect(page.getByRole('link', { name: 'Weekly sync QA' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Planning QA' })).toBeVisible();
    await expect(page.getByTestId('meeting-status')).toHaveCount(2);
  });

  test('[E2E-09] meetings list against the real API shows the empty state', async ({
    page,
    api,
  }) => {
    // BE-GAP-1: the API (integration/phase-1) has no GET /orgs/:id/meetings yet, so this fails
    // with the error state until Backend ships the endpoint. Left failing on purpose.
    test.fail(true, 'BE-GAP-1: GET /orgs/:id/meetings not implemented in the API');
    const { email } = await seedUser(api, ['Empty QA']);
    await uiLogin(page, email, PASSWORD);
    await page.goto('/meetings');
    await expect(page.getByText('No meetings yet')).toBeVisible({ timeout: 5000 });
  });

  test('[E2E-10] signed-in page redirects to /login when API requests are aborted', async ({
    page,
    api,
  }) => {
    const { email } = await seedUser(api, ['Abort QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login\?next=%2Fmeetings/, { timeout: 10_000 });
  });

  test('[E2E-11] signed-in page redirects to /login when the API is stopped', async ({
    page,
    api,
    stack,
  }) => {
    const { email } = await seedUser(api, ['Stop QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await stack.stopApi();
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/login\?next=%2Fmeetings/, { timeout: 10_000 });
  });

  for (const [id, label, fulfill] of [
    [
      'E2E-12',
      '503 JSON error',
      { status: 503, json: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } } },
    ],
    [
      'E2E-13',
      '502 proxy HTML page',
      { status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' },
    ],
  ] as const) {
    test(`[${id}] signed-in page redirects to /login?next= on a ${label} from the API`, async ({
      page,
      api,
    }) => {
      const { email } = await seedUser(api, ['5xx QA']);
      await uiLogin(page, email, PASSWORD);
      await expect(page.getByTestId('app-shell')).toBeVisible();
      await page.route('**/api/**', (route) => route.fulfill(fulfill));
      await page.goto('/meetings');
      await expect(page).toHaveURL(/\/login\?next=%2Fmeetings/, { timeout: 10_000 });
    });
  }

  test('[E2E-14] [AU-20] no session or CSRF tokens in web storage; session cookie is httpOnly', async ({
    page,
    api,
    context,
  }) => {
    const { email } = await seedUser(api, ['Storage QA']);
    await uiLogin(page, email, PASSWORD);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    const cookies = await context.cookies();
    const sid = cookies.find((c) => c.name.endsWith('meetops_sid'));
    expect(sid, 'session cookie set').toBeDefined();
    expect(sid!.httpOnly).toBe(true);
    const dump = await page.evaluate(() => {
      const all: string[] = [];
      for (const s of [localStorage, sessionStorage])
        for (let i = 0; i < s.length; i++) all.push(`${s.key(i)}=${s.getItem(s.key(i)!)}`);
      return { storage: all.join('\n'), cookie: document.cookie };
    });
    expect(dump.storage).not.toContain(sid!.value);
    expect(dump.storage).not.toMatch(/sid|session[_-]?token|bearer|csrf/i);
    // JS can read the CSRF cookie by design (double submit), but never the session id.
    expect(dump.cookie).not.toContain(sid!.value);
  });

  // Open redirect: ?next= must only ever lead to a same-origin path (PR #48 safeRedirect).
  for (const next of [
    'https://evil.example/',
    '//evil.example/',
    '/%2F%2Fevil.example/',
    '/\\evil.example/',
    '/.//evil.example/',
    'javascript:alert(1)',
  ]) {
    test(`[E2E-15] malicious ?next=${next} stays on the app origin after login`, async ({
      page,
      api,
      stack,
    }) => {
      const { email } = await seedUser(api, ['Redirect QA']);
      const offsite: string[] = [];
      await page.route(
        (u) => u.hostname.includes('evil.example'),
        (route) => {
          offsite.push(route.request().url());
          return route.abort();
        },
      );
      page.on('dialog', (d) => {
        offsite.push(`dialog:${d.message()}`);
        void d.dismiss();
      });
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await loginButton(page).click();
      await expect(page.getByTestId('app-shell')).toBeVisible();
      expect(new URL(page.url()).origin).toBe(stack.origin);
      expect(new URL(page.url()).pathname).not.toMatch(/evil/);
      expect(offsite).toEqual([]);
    });
  }
});
