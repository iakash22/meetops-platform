import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  ConnectIntegrationResponse,
  IntegrationIssue,
  IntegrationProviderList,
} from '@meetops/contracts';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import {
  devIntegrationsRuntime,
  type IntegrationsRuntime,
  integrationsRuntimeFromEnv,
} from '../src/modules/integrations/runtime.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { selectIntegrationsRuntime } from '../src/modules/integrations/index.js';
import { IntegrationsService } from '../src/modules/integrations/service.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const CLOUD = '11111111-2222-4333-8444-555555555555';
const GH_SECRET = 'gh-app-webhook-secret';
const API = 'http://localhost:4000';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body?: string };
function fakeFetch(calls: Call[], over: Record<string, () => Response> = {}) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const key = `${method} ${url.split('?')[0]}`;
    if (over[key]) return over[key]();
    switch (key) {
      case 'POST https://auth.atlassian.com/oauth/token':
        return json({
          access_token: 'jira-access',
          refresh_token: 'jira-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'read:jira-work write:jira-work read:jira-user offline_access',
        });
      case 'GET https://api.atlassian.com/oauth/token/accessible-resources':
        return json([
          {
            id: CLOUD,
            url: 'https://acme.atlassian.net',
            name: 'Acme',
            scopes: ['read:jira-work', 'write:jira-work'],
          },
        ]);
      case `POST https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue`:
        return json({ id: '10001', key: 'OPS-7' }, 201);
      case `GET https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/OPS-7`:
        return json({
          key: 'OPS-7',
          fields: {
            summary: 'Ship it',
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            labels: [],
          },
        });
      case 'POST https://github.com/login/oauth/access_token':
        return json({ access_token: 'ghu_user', token_type: 'bearer' });
      case 'GET https://api.github.com/user/installations':
        return json({ total_count: 1, installations: [{ id: 99 }] });
      case 'GET https://api.github.com/app/installations/99':
        return json({ id: 99, account: { login: 'acme', type: 'Organization' } });
      case 'POST https://api.github.com/app/installations/99/access_tokens':
        return json(
          { token: 'ghs_inst', expires_at: new Date(Date.now() + 3600e3).toISOString() },
          201,
        );
      case 'POST https://api.github.com/repos/acme/app/issues':
        return json(
          {
            number: 5,
            html_url: 'https://github.com/acme/app/issues/5',
            state: 'open',
            title: 't',
            labels: [],
          },
          201,
        );
      default:
        return json({ message: `unexpected ${key}` }, 500);
    }
  };
}

describe('Phase 5 integration flows', () => {
  let app: App;
  let repo: InMemoryIntegrations;
  let audit: InMemoryAuditLog;
  let rt: IntegrationsRuntime;
  let calls: Call[];
  let overrides: Record<string, () => Response>;

  beforeEach(async () => {
    repo = new InMemoryIntegrations();
    audit = new InMemoryAuditLog();
    calls = [];
    overrides = {};
    rt = devIntegrationsRuntime({
      apiOrigin: API,
      fetch: (i, init) => fakeFetch(calls, overrides)(i, init),
      jira: { clientId: 'jira-client', clientSecret: async () => 'jira-secret' },
      github: {
        appSlug: 'meetops-test',
        appId: '123',
        clientId: 'Iv1.abc',
        privateKey: async () => pem,
        clientSecret: async () => 'gh-client-secret',
        webhookSecret: async () => GH_SECRET,
      },
    });
    app = await buildApp({
      integrations: repo,
      audit,
      integrationsRuntime: rt,
    } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const owner = async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    return { c, org: await createOrg(c, 'Acme') };
  };
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

  describe('connect and callback', () => {
    it('Jira: PKCE authorize URL, signed state, tokens stored, audited, state single-use', async () => {
      const { c, org } = await owner();
      const res = await c.post(`/orgs/${org}/integrations/connect`, {
        provider: 'jira',
        returnTo: '/settings/x',
      });
      expect(res.statusCode).toBe(200);
      expect(Value.Check(ConnectIntegrationResponse, res.json())).toBe(true);
      const url = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl);
      expect(url.origin).toBe('https://auth.atlassian.com');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe(`${API}/integrations/jira/callback`);
      expect(res.body).not.toMatch(/verifier/i);
      const state = stateOf(url.toString());

      const cb = await c.get(`/integrations/jira/callback?state=${state}&code=abc123`);
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe(
        'http://localhost:3000/settings/x?integration=jira&status=connected',
      );
      const tokenCall = calls.find((x) => x.url === 'https://auth.atlassian.com/oauth/token')!;
      expect(tokenCall.body).toMatch(/code_verifier/);
      const row = [...repo.rows.values()][0]!;
      expect(row).toMatchObject({
        provider: 'jira',
        externalAccountId: CLOUD,
        displayName: 'acme.atlassian.net',
        organizationId: org,
      });
      expect(repo.secrets.get(row.id)).toMatchObject({
        accessToken: 'jira-access',
        refreshToken: 'jira-refresh',
      });
      const ev = audit.events.find((e) => e.action === 'integration.connect')!;
      expect(ev.targetId).toBe(row.id);
      expect(JSON.stringify(audit.events)).not.toMatch(/jira-access|jira-refresh|jira-secret/);

      const again = await c.get(`/integrations/jira/callback?state=${state}&code=abc123`);
      expect(again.statusCode).toBe(400);
    });

    it('rejects tampered, foreign-session and multi-site callbacks', async () => {
      const { c, org } = await owner();
      const s1 = stateOf(
        (await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' })).json<{
          authorizeUrl: string;
        }>().authorizeUrl,
      );
      const bad = (s1[0] === 'A' ? 'B' : 'A') + s1.slice(1);
      expect((await c.get(`/integrations/jira/callback?state=${bad}&code=abc`)).statusCode).toBe(
        400,
      );
      const other = await signupAndLogin(app, 'other@example.com');
      await createOrg(other, 'Other');
      expect((await other.get(`/integrations/jira/callback?state=${s1}&code=abc`)).statusCode).toBe(
        400,
      );
      expect(
        (
          await new (c.constructor as typeof Client)(app).get(
            `/integrations/jira/callback?state=${s1}&code=abc`,
          )
        ).statusCode,
      ).toBe(401);

      overrides['GET https://api.atlassian.com/oauth/token/accessible-resources'] = () =>
        json([
          { id: CLOUD, url: 'https://a.atlassian.net', scopes: ['read:jira-work'] },
          { id: randomUUID(), url: 'https://b.atlassian.net', scopes: ['read:jira-work'] },
        ]);
      const s2 = stateOf(
        (await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' })).json<{
          authorizeUrl: string;
        }>().authorizeUrl,
      );
      expect((await c.get(`/integrations/jira/callback?state=${s2}&code=abc`)).statusCode).toBe(
        400,
      );
      expect(repo.rows.size).toBe(0);
    });

    it('denied consent burns the state and redirects back', async () => {
      const { c, org } = await owner();
      const s = stateOf(
        (await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' })).json<{
          authorizeUrl: string;
        }>().authorizeUrl,
      );
      const r = await c.get(`/integrations/jira/callback?state=${s}&error=access_denied`);
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toMatch(/status=denied/);
      expect((await c.get(`/integrations/jira/callback?state=${s}&code=abc`)).statusCode).toBe(400);
    });

    it('upstream failures are a sanitized 502', async () => {
      const { c, org } = await owner();
      overrides['POST https://auth.atlassian.com/oauth/token'] = () =>
        json({ error: 'server_error', detail: 'jira-secret' }, 500);
      const s = stateOf(
        (await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' })).json<{
          authorizeUrl: string;
        }>().authorizeUrl,
      );
      const r = await c.get(`/integrations/jira/callback?state=${s}&code=abc`);
      expect(r.statusCode).toBe(502);
      expect(r.body).not.toMatch(/jira-secret|server_error/);
    });

    it('GitHub: install URL, user must see the installation, installation token stored', async () => {
      const { c, org } = await owner();
      const res = await c.post(`/orgs/${org}/integrations/connect`, { provider: 'github' });
      const url = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl);
      expect(url.href.startsWith('https://github.com/apps/meetops-test/installations/new')).toBe(
        true,
      );
      const s = stateOf(url.href);
      const cb = await c.get(
        `/integrations/github/callback?state=${s}&code=ghcode&installation_id=99&setup_action=install`,
      );
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toMatch(/integration=github&status=connected/);
      const row = [...repo.rows.values()][0]!;
      expect(row).toMatchObject({
        provider: 'github',
        externalAccountId: '99',
        displayName: 'acme',
      });
      expect(repo.secrets.get(row.id)).toMatchObject({ accessToken: 'ghs_inst' });
    });

    it('GitHub: an installation the user cannot access is rejected', async () => {
      const { c, org } = await owner();
      overrides['GET https://api.github.com/user/installations'] = () =>
        json({ installations: [{ id: 7 }] });
      const s = stateOf(
        (await c.post(`/orgs/${org}/integrations/connect`, { provider: 'github' })).json<{
          authorizeUrl: string;
        }>().authorizeUrl,
      );
      const r = await c.get(
        `/integrations/github/callback?state=${s}&code=ghcode&installation_id=99&setup_action=install`,
      );
      expect(r.statusCode).toBe(400);
      expect(repo.rows.size).toBe(0);
      expect(calls.some((x) => x.url.endsWith('/access_tokens'))).toBe(false);
    });

    it('connect requires update rights, CSRF and origin', async () => {
      const { c, org } = await owner();
      const noCsrf = await app.inject({
        method: 'POST',
        url: `/orgs/${org}/integrations/connect`,
        payload: { provider: 'jira' },
        headers: { cookie: c.cookie, origin: 'http://localhost:5173' },
      });
      expect(noCsrf.statusCode).toBe(403);
      const badOrigin = await c.post(
        `/orgs/${org}/integrations/connect`,
        { provider: 'jira' },
        { origin: 'https://evil.example' },
      );
      expect(badOrigin.statusCode).toBe(403);
      const delNoCsrf = await app.inject({
        method: 'DELETE',
        url: `/orgs/${org}/integrations/${randomUUID()}`,
        headers: { cookie: c.cookie, origin: 'http://localhost:5173' },
      });
      expect(delNoCsrf.statusCode).toBe(403);
    });

    it('runtime selection: production without a runtime is 503; dev fallback has no providers (409)', async () => {
      expect(selectIntegrationsRuntime({} as ModuleDeps, 'production')).toBeUndefined();
      expect(selectIntegrationsRuntime({ integrationsRuntime: rt } as never, 'production')).toBe(
        rt,
      );
      await expect(
        new IntegrationsService(repo, undefined).connect({
          organizationId: randomUUID(),
          userId: randomUUID(),
          provider: 'jira',
        }),
      ).rejects.toMatchObject({ statusCode: 503 });
      await app.close();
      app = await buildApp({ integrations: repo, audit } as Partial<ModuleDeps>);
      const { c, org } = await owner();
      expect(
        (await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' })).statusCode,
      ).toBe(409);
    });
  });

  describe('webhooks', () => {
    const seed = (
      org: string,
      provider: 'github' | 'jira',
      extra = provider === 'github' ? '99' : CLOUD,
    ) => {
      const id = randomUUID();
      repo.add(
        {
          id,
          organizationId: org,
          provider,
          status: 'active',
          displayName: 'acme',
          externalAccountId: extra,
          connectedById: randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { accessToken: 'a', refreshToken: null, webhookSecret: 'jira-hook-secret' },
      );
      return id;
    };
    const linkTask = (
      org: string,
      integrationId: string,
      provider: 'github' | 'jira',
      externalId: string,
    ) => {
      const taskId = randomUUID();
      repo.tasks.set(taskId, {
        id: taskId,
        organizationId: org,
        title: 't',
        description: null,
        extractedTaskId: null,
        status: 'todo',
      });
      repo.issues.push({
        id: randomUUID(),
        organizationId: org,
        integrationId,
        taskId,
        provider,
        externalId,
        createdAt: new Date().toISOString(),
      });
      return taskId;
    };
    const sign = (secret: string, body: string) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const post = (url: string, body: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url,
        payload: body,
        headers: { 'content-type': 'application/json', ...headers },
      });

    it('GitHub: verified delivery updates the linked task; replay is 409; bad signature 401', async () => {
      const { org } = await owner();
      const id = seed(org, 'github');
      const taskId = linkTask(org, id, 'github', 'acme/app#5');
      const body = JSON.stringify({
        action: 'closed',
        issue: { number: 5, state: 'closed', state_reason: 'completed' },
        repository: { full_name: 'acme/app' },
        installation: { id: 99 },
      });
      const h = {
        'x-hub-signature-256': sign(GH_SECRET, body),
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
      };
      const r = await post(`/webhooks/github/${id}`, body, h);
      expect(r.statusCode).toBe(202);
      expect(r.json()).toEqual({ received: true });
      expect(repo.tasks.get(taskId)!.status).toBe('done');
      expect((await post(`/webhooks/github/${id}`, body, h)).statusCode).toBe(409);
      expect(
        (
          await post(`/webhooks/github/${id}`, body, {
            ...h,
            'x-github-delivery': randomUUID(),
            'x-hub-signature-256': sign('wrong', body),
          })
        ).statusCode,
      ).toBe(401);
    });

    it('GitHub: payload for another installation, unknown or revoked ids are 401', async () => {
      const { c, org } = await owner();
      const id = seed(org, 'github');
      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 1 },
        repository: { full_name: 'x/y' },
        installation: { id: 98 },
      });
      const h = {
        'x-hub-signature-256': sign(GH_SECRET, body),
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
      };
      expect((await post(`/webhooks/github/${id}`, body, h)).statusCode).toBe(401);
      expect((await post(`/webhooks/github/${randomUUID()}`, body, h)).statusCode).toBe(401);
      expect((await post(`/webhooks/jira/${id}`, body, h)).statusCode).toBe(401);
      await c.delete(`/orgs/${org}/integrations/${id}`);
      const ok = body.replace('98', '99');
      expect(
        (
          await post(`/webhooks/github/${id}`, ok, {
            ...h,
            'x-hub-signature-256': sign(GH_SECRET, ok),
          })
        ).statusCode,
      ).toBe(401);
    });

    it('Jira: per-connection secret, status category mapping, replay rejection', async () => {
      const { org } = await owner();
      const id = seed(org, 'jira');
      const taskId = linkTask(org, id, 'jira', 'OPS-7');
      const body = JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'indeterminate' } } } },
      });
      const h = {
        'x-hub-signature': sign('jira-hook-secret', body),
        'x-atlassian-webhook-identifier': 'abc-1',
      };
      expect((await post(`/webhooks/jira/${id}`, body, h)).statusCode).toBe(202);
      expect(repo.tasks.get(taskId)!.status).toBe('in_progress');
      expect((await post(`/webhooks/jira/${id}`, body, h)).statusCode).toBe(409);
      expect(
        (
          await post(`/webhooks/jira/${id}`, body, {
            ...h,
            'x-atlassian-webhook-identifier': 'abc-2',
            'x-hub-signature': sign('nope', body),
          })
        ).statusCode,
      ).toBe(401);
    });

    it('rejects oversize bodies and malformed params without a session', async () => {
      const { org } = await owner();
      const id = seed(org, 'jira');
      const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
      expect(
        (
          await post(`/webhooks/jira/${id}`, big, {
            'x-hub-signature': sign('jira-hook-secret', big),
          })
        ).statusCode,
      ).toBe(413);
      expect((await post(`/webhooks/jira/not-a-uuid`, '{}', {})).statusCode).toBe(400);
      expect((await post(`/webhooks/gitlab/${id}`, '{}', {})).statusCode).toBe(400);
    });
  });

  describe('issue push', () => {
    async function setup(
      provider: 'github' | 'jira',
      decision: 'approved' | 'rejected' = 'approved',
    ) {
      const { c, org } = await owner();
      const integrationId = randomUUID();
      repo.add(
        {
          id: integrationId,
          organizationId: org,
          provider,
          status: 'active',
          displayName: provider === 'jira' ? 'acme.atlassian.net' : 'acme',
          externalAccountId: provider === 'jira' ? CLOUD : '99',
          connectedById: randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { accessToken: 'jira-old', refreshToken: 'jira-r0', webhookSecret: 'w' },
        provider === 'jira' ? new Date(Date.now() + 3600e3) : null,
      );
      const taskId = randomUUID();
      const extractedTaskId = randomUUID();
      repo.tasks.set(taskId, {
        id: taskId,
        organizationId: org,
        title: 'Ship it',
        description: 'desc',
        extractedTaskId,
        status: 'todo',
      });
      const approvalId = randomUUID();
      repo.approvals.set(approvalId, {
        id: approvalId,
        organizationId: org,
        extractedTaskId,
        reviewerId: randomUUID(),
        decision,
      });
      return { c, org, integrationId, taskId, approvalId };
    }
    const url = (org: string, taskId: string) => `/orgs/${org}/tasks/${taskId}/integration-issues`;

    it('GitHub: creates the issue once with an installation token and links it', async () => {
      const s = await setup('github');
      const r = await s.c.post(url(s.org, s.taskId), {
        integrationId: s.integrationId,
        approvalId: s.approvalId,
        target: 'acme/app',
      });
      expect(r.statusCode).toBe(201);
      expect(Value.Check(IntegrationIssue, r.json())).toBe(true);
      expect(r.json()).toMatchObject({
        externalId: 'acme/app#5',
        externalUrl: 'https://github.com/acme/app/issues/5',
        taskId: s.taskId,
      });
      expect(calls.filter((x) => x.url.endsWith('/repos/acme/app/issues'))).toHaveLength(1);
      expect(
        audit.events.filter((e) => e.action === 'integration.issue_push').length,
      ).toBeGreaterThan(0);
      expect(JSON.stringify(audit.events)).not.toMatch(/ghs_inst/);
      const again = await s.c.post(url(s.org, s.taskId), {
        integrationId: s.integrationId,
        approvalId: s.approvalId,
        target: 'acme/app',
      });
      expect(again.statusCode).toBe(409);
    });

    it('Jira: refreshes a near-expiry token, stores the rotated pair, creates the issue', async () => {
      const s = await setup('jira');
      repo.rows.get(s.integrationId)!.accessTokenExpiresAt = new Date(Date.now() + 30_000);
      const r = await s.c.post(url(s.org, s.taskId), {
        integrationId: s.integrationId,
        approvalId: s.approvalId,
        target: 'OPS',
      });
      expect(r.statusCode).toBe(201);
      expect(r.json().externalId).toBe('OPS-7');
      expect(repo.secrets.get(s.integrationId)).toMatchObject({
        accessToken: 'jira-access',
        refreshToken: 'jira-refresh',
      });
      expect(calls.filter((x) => x.url === 'https://auth.atlassian.com/oauth/token')).toHaveLength(
        1,
      );
    });

    it('a provider 5xx is not retried; sanitized 502 and no link', async () => {
      const s = await setup('github');
      overrides['POST https://api.github.com/repos/acme/app/issues'] = () =>
        json({ message: 'boom' }, 502);
      const r = await s.c.post(url(s.org, s.taskId), {
        integrationId: s.integrationId,
        approvalId: s.approvalId,
        target: 'acme/app',
      });
      expect(r.statusCode).toBe(502);
      expect(calls.filter((x) => x.url.endsWith('/repos/acme/app/issues'))).toHaveLength(1);
      expect(repo.issues).toHaveLength(0);
    });

    it('rejects unapproved, mismatched, wrong-target, missing and inactive cases', async () => {
      const s = await setup('github', 'rejected');
      const body = { integrationId: s.integrationId, approvalId: s.approvalId, target: 'acme/app' };
      expect((await s.c.post(url(s.org, s.taskId), body)).statusCode).toBe(403);
      repo.approvals.get(s.approvalId)!.decision = 'approved';
      repo.approvals.get(s.approvalId)!.extractedTaskId = randomUUID();
      expect((await s.c.post(url(s.org, s.taskId), body)).statusCode).toBe(403);
      expect((await s.c.post(url(s.org, s.taskId), { ...body, target: 'OPS' })).statusCode).toBe(
        400,
      );
      expect((await s.c.post(url(s.org, randomUUID()), body)).statusCode).toBe(404);
      expect(
        (await s.c.post(url(s.org, s.taskId), { ...body, integrationId: randomUUID() })).statusCode,
      ).toBe(404);
      repo.rows.get(s.integrationId)!.status = 'error';
      expect((await s.c.post(url(s.org, s.taskId), body)).statusCode).toBe(409);
      expect(calls.some((x) => x.url.includes('/issues'))).toBe(false);
    });

    it('members cannot push', async () => {
      const s = await setup('github');
      const m = await signupAndLogin(app, 'm@example.com');
      expect(
        (await s.c.post(`/orgs/${s.org}/invitations`, { email: 'm@example.com', role: 'member' }))
          .statusCode,
      ).toBe(201);
      const sent = [...app.mail.sent].reverse().find((x) => x.template === 'invitation');
      await m.post('/invitations/accept', {
        token: new URL(sent!.data.url!).searchParams.get('token')!,
      });
      await m.post('/orgs/switch', { organizationId: s.org });
      const r = await m.post(url(s.org, s.taskId), {
        integrationId: s.integrationId,
        approvalId: s.approvalId,
        target: 'acme/app',
      });
      expect(r.statusCode).toBe(403);
    });
  });

  describe('providers catalogue (v0.12.0)', () => {
    it('lists github and jira as configured and not connected, then jira active after connect', async () => {
      const { c, org } = await owner();
      const before = await c.get(`/orgs/${org}/integrations/providers`);
      expect(before.statusCode).toBe(200);
      expect(Value.Check(IntegrationProviderList, before.json())).toBe(true);
      expect(before.json()).toEqual({
        items: [
          { provider: 'github', configured: true, connectionStatus: 'not_connected' },
          { provider: 'jira', configured: true, connectionStatus: 'not_connected' },
        ],
      });
      const res = await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' });
      const state = stateOf(res.json<{ authorizeUrl: string }>().authorizeUrl);
      expect(
        (await c.get(`/integrations/jira/callback?state=${state}&code=abc123`)).statusCode,
      ).toBe(302);
      const after = await c.get(`/orgs/${org}/integrations/providers`);
      const jira = after.json<IntegrationProviderList>().items.find((i) => i.provider === 'jira')!;
      expect(jira.connectionStatus).toBe('active');
      expect(jira.integration?.displayName).toBe('acme.atlassian.net');
      expect(after.body).not.toMatch(/jira-access|jira-refresh|secret/i);
    });

    it('reports configured=false when the deployment has no provider app', async () => {
      await app.close();
      app = await buildApp({
        integrations: repo,
        audit,
        integrationsRuntime: devIntegrationsRuntime({ apiOrigin: API }),
      } as Partial<ModuleDeps>);
      const { c, org } = await owner();
      const r = await c.get(`/orgs/${org}/integrations/providers`);
      expect(r.json<IntegrationProviderList>().items.every((i) => !i.configured)).toBe(true);
    });

    it('requires a session and org membership', async () => {
      const { org } = await owner();
      expect(
        (await app.inject({ method: 'GET', url: `/orgs/${org}/integrations/providers` }))
          .statusCode,
      ).toBe(401);
      const other = await signupAndLogin(app, 'stranger@example.com');
      expect([403, 404]).toContain(
        (await other.get(`/orgs/${org}/integrations/providers`)).statusCode,
      );
    });
  });
});

describe('integrationsRuntimeFromEnv (dev overlay)', () => {
  it('configures nothing without env and both providers when fully set', async () => {
    expect(integrationsRuntimeFromEnv({})).toEqual({});
    const partial = integrationsRuntimeFromEnv({ GITHUB_APP_ID: '1', JIRA_CLIENT_ID: 'x' });
    expect(partial.github).toBeUndefined();
    expect(partial.jira).toBeUndefined();
    const full = integrationsRuntimeFromEnv(
      {
        GITHUB_APP_ID: '1',
        GITHUB_APP_SLUG: 'slug',
        GITHUB_APP_CLIENT_ID: 'cid',
        GITHUB_APP_CLIENT_SECRET: 'cs',
        GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem',
        GITHUB_APP_WEBHOOK_SECRET: 'ws',
        JIRA_CLIENT_ID: 'jid',
        JIRA_CLIENT_SECRET: 'js',
        INTEGRATIONS_API_ORIGIN: 'https://x.trycloudflare.com',
      },
      async (p) => `pem:${p}`,
    );
    expect(full.apiOrigin).toBe('https://x.trycloudflare.com');
    expect(full.github?.appSlug).toBe('slug');
    expect(await full.github?.privateKey()).toBe('pem:/k.pem');
    expect(await full.jira?.clientSecret()).toBe('js');
  });
});
