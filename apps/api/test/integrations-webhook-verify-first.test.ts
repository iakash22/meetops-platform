import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { ModuleDeps } from '../src/modules/index.js';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import { IntegrationsService } from '../src/modules/integrations/service.js';
import { WebhookSignatureError } from '../src/modules/integrations/errors.js';
import { devIntegrationsRuntime } from '../src/modules/integrations/runtime.js';
import { buildApp, type App } from './helpers.js';

const GH_SECRET = 'gh-app-webhook-secret';
const JIRA_SECRET = 'jira-hook-secret';
const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const sign256 = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('per-integration webhook: verify before org lookup (F3)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const runtime = () =>
    devIntegrationsRuntime({
      apiOrigin: 'http://api.test',
      github: {
        appSlug: 'meetops-test',
        appId: '123',
        clientId: 'Iv1.abc',
        privateKey: async () => pem,
        clientSecret: async () => 'gh-client-secret',
        webhookSecret: async () => GH_SECRET,
      },
    });

  const seedGitHub = (repo: InMemoryIntegrations, org = randomUUID()) => {
    const id = randomUUID();
    repo.add(
      {
        id,
        organizationId: org,
        provider: 'github',
        status: 'active',
        displayName: 'acme',
        externalAccountId: '99',
        connectedById: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { accessToken: 'a', refreshToken: null, webhookSecret: 'unused' },
    );
    return { id, org };
  };

  const seedJira = (repo: InMemoryIntegrations, org = randomUUID()) => {
    const id = randomUUID();
    repo.add(
      {
        id,
        organizationId: org,
        provider: 'jira',
        status: 'active',
        displayName: 'acme',
        externalAccountId: '11111111-2222-4333-8444-555555555555',
        connectedById: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { accessToken: 'a', refreshToken: null, webhookSecret: JIRA_SECRET },
    );
    return { id, org };
  };

  const linkTask = (
    repo: InMemoryIntegrations,
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

  it('GitHub: a bad signature does no org resolution, get, or status apply', async () => {
    const repo = new InMemoryIntegrations();
    const { id } = seedGitHub(repo);
    const resolveOrganization = vi.spyOn(repo, 'resolveOrganization');
    const get = vi.spyOn(repo, 'get');
    const applyIssueStatus = vi.spyOn(repo, 'applyIssueStatus');
    const service = new IntegrationsService(repo, runtime());
    const body = Buffer.from(
      JSON.stringify({
        action: 'opened',
        issue: { number: 1 },
        repository: { full_name: 'acme/app' },
        installation: { id: 99 },
      }),
    );
    await expect(
      service.webhook({
        provider: 'github',
        integrationId: id,
        rawBody: body,
        headers: {
          'x-hub-signature-256': sign256('wrong', body.toString()),
          'x-github-event': 'issues',
          'x-github-delivery': randomUUID(),
        },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(resolveOrganization).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(applyIssueStatus).not.toHaveBeenCalled();
  });

  it('Jira: a bad signature only does the secret lookup (no get / status apply)', async () => {
    const repo = new InMemoryIntegrations();
    const { id } = seedJira(repo);
    const resolveWebhookSecret = vi.spyOn(repo, 'resolveWebhookSecret');
    const get = vi.spyOn(repo, 'get');
    const applyIssueStatus = vi.spyOn(repo, 'applyIssueStatus');
    const resolveOrganization = vi.spyOn(repo, 'resolveOrganization');
    const service = new IntegrationsService(repo, runtime());
    const body = Buffer.from(
      JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'new' } } } },
      }),
    );
    await expect(
      service.webhook({
        provider: 'jira',
        integrationId: id,
        rawBody: body,
        headers: {
          'x-hub-signature': sign256('wrong', body.toString()),
          'x-atlassian-webhook-identifier': 'abc-bad',
        },
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(resolveWebhookSecret).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(applyIssueStatus).not.toHaveBeenCalled();
    // In-memory resolveWebhookSecret does not call resolveOrganization; prisma may.
    expect(resolveOrganization).not.toHaveBeenCalled();
  });

  it('unknown integration and bad signature return identical 401 bodies', async () => {
    const repo = new InMemoryIntegrations();
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
    } as Partial<ModuleDeps>);
    const { id } = seedJira(repo);
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'new' } } } },
    });
    const badKnown = await app.inject({
      method: 'POST',
      url: `/webhooks/jira/${id}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': sign256('wrong', body),
        'x-atlassian-webhook-identifier': 'id-1',
      },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: `/webhooks/jira/${randomUUID()}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': sign256(JIRA_SECRET, body),
        'x-atlassian-webhook-identifier': 'id-2',
      },
    });
    expect(badKnown.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(badKnown.headers['content-type']).toBe(unknown.headers['content-type']);
    const strip = (b: { error: Record<string, unknown> }) => {
      const rest = { ...b.error };
      delete rest.requestId;
      return rest;
    };
    expect(strip(badKnown.json())).toEqual(strip(unknown.json()));
  });

  it('a valid GitHub signature still processes after the early HMAC check', async () => {
    const repo = new InMemoryIntegrations();
    const { id, org } = seedGitHub(repo);
    const taskId = linkTask(repo, org, id, 'github', 'acme/app#5');
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
    } as Partial<ModuleDeps>);
    const body = JSON.stringify({
      action: 'closed',
      issue: { number: 5, state: 'closed', state_reason: 'completed' },
      repository: { full_name: 'acme/app' },
      installation: { id: 99 },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/webhooks/github/${id}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign256(GH_SECRET, body),
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
      },
    });
    expect(r.statusCode).toBe(202);
    expect(repo.tasks.get(taskId)!.status).toBe('done');
  });

  it('a valid Jira signature still processes after the early HMAC check', async () => {
    const repo = new InMemoryIntegrations();
    const { id, org } = seedJira(repo);
    const taskId = linkTask(repo, org, id, 'jira', 'OPS-7');
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
    } as Partial<ModuleDeps>);
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'indeterminate' } } } },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/webhooks/jira/${id}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': sign256(JIRA_SECRET, body),
        'x-atlassian-webhook-identifier': 'abc-ok',
      },
    });
    expect(r.statusCode).toBe(202);
    expect(repo.tasks.get(taskId)!.status).toBe('in_progress');
  });

  it('per-IP rate limit still runs before webhook handling', async () => {
    const repo = new InMemoryIntegrations();
    const resolveWebhookSecret = vi.spyOn(repo, 'resolveWebhookSecret');
    const resolveOrganization = vi.spyOn(repo, 'resolveOrganization');
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
      webhookRateLimits: {
        perIp: { limit: 1, windowMs: 60_000 },
        perTarget: { limit: 100, windowMs: 60_000 },
        unsignedPerIp: { limit: 50, windowMs: 60_000 },
      },
    } as Partial<ModuleDeps>);
    const url = `/webhooks/jira/${randomUUID()}`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
          remoteAddress: '203.0.113.50',
        })
      ).statusCode,
    ).toBe(401);
    // First request may have looked up a secret; further rate-limited requests must not reach the service.
    const secretCallsAfterFirst = resolveWebhookSecret.mock.calls.length;
    const orgCallsAfterFirst = resolveOrganization.mock.calls.length;
    const limited = await app.inject({
      method: 'POST',
      url,
      payload: '{}',
      headers: { 'content-type': 'application/json' },
      remoteAddress: '203.0.113.50',
    });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(resolveWebhookSecret.mock.calls.length).toBe(secretCallsAfterFirst);
    expect(resolveOrganization.mock.calls.length).toBe(orgCallsAfterFirst);
  });

  it('GitHub unknown-id and bad-signature 401 responses have identical bodies', async () => {
    const repo = new InMemoryIntegrations();
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
    } as Partial<ModuleDeps>);
    const { id } = seedGitHub(repo);
    const body = JSON.stringify({
      action: 'opened',
      issue: { number: 1 },
      repository: { full_name: 'acme/app' },
      installation: { id: 99 },
    });
    const badKnown = await app.inject({
      method: 'POST',
      url: `/webhooks/github/${id}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign256('wrong', body),
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
      },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: `/webhooks/github/${randomUUID()}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign256(GH_SECRET, body),
        'x-github-event': 'issues',
        'x-github-delivery': randomUUID(),
      },
    });
    expect(badKnown.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(badKnown.headers['content-type']).toBe(unknown.headers['content-type']);
    const strip = (b: { error: Record<string, unknown> }) => {
      const rest = { ...b.error };
      delete rest.requestId;
      return rest;
    };
    expect(strip(badKnown.json())).toEqual(strip(unknown.json()));
  });

  it('a known integration with a missing signature header gets a 401 and no DB secret read', async () => {
    const repo = new InMemoryIntegrations();
    const { id } = seedJira(repo);
    const resolveWebhookSecret = vi.spyOn(repo, 'resolveWebhookSecret');
    const readSecrets = vi.spyOn(repo, 'readSecrets');
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
    } as Partial<ModuleDeps>);
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'new' } } } },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/webhooks/jira/${id}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-atlassian-webhook-identifier': 'abc-missing-sig',
      },
    });
    expect(r.statusCode).toBe(401);
    expect(resolveWebhookSecret).not.toHaveBeenCalled();
    expect(readSecrets).not.toHaveBeenCalled();
  });

  it('Jira early HMAC accepts a mixed-case signature header on a plain header bag', async () => {
    const repo = new InMemoryIntegrations();
    const { id, org } = seedJira(repo);
    const taskId = linkTask(repo, org, id, 'jira', 'OPS-7');
    const service = new IntegrationsService(repo, runtime());
    const body = Buffer.from(
      JSON.stringify({
        webhookEvent: 'jira:issue_updated',
        issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'indeterminate' } } } },
      }),
    );
    await expect(
      service.webhook({
        provider: 'jira',
        integrationId: id,
        rawBody: body,
        headers: {
          'X-Hub-Signature': sign256(JIRA_SECRET, body.toString()),
          'X-Atlassian-Webhook-Identifier': 'abc-case-bag',
        },
      }),
    ).resolves.toBe(1);
    expect(repo.tasks.get(taskId)!.status).toBe('in_progress');
  });

  it('a valid Jira signature still processes when the signature header is mixed-case', async () => {
    const repo = new InMemoryIntegrations();
    const { id, org } = seedJira(repo);
    const taskId = linkTask(repo, org, id, 'jira', 'OPS-7');
    app = await buildApp({
      integrations: repo,
      integrationsRuntime: runtime(),
    } as Partial<ModuleDeps>);
    const body = JSON.stringify({
      webhookEvent: 'jira:issue_updated',
      issue: { key: 'OPS-7', fields: { status: { statusCategory: { key: 'indeterminate' } } } },
    });
    const r = await app.inject({
      method: 'POST',
      url: `/webhooks/jira/${id}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        'X-Hub-Signature': sign256(JIRA_SECRET, body),
        'x-atlassian-webhook-identifier': 'abc-case',
      },
    });
    expect(r.statusCode).toBe(202);
    expect(repo.tasks.get(taskId)!.status).toBe('in_progress');
  });
});
