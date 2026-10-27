import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  API_ERROR_REASONS,
  ConnectIntegrationRequest,
  INTEGRATION_ERROR_REASONS,
  INTEGRATION_PATHS,
  Integration,
  IntegrationCallbackQuery,
  PushTaskIssueRequest,
  WebhookParams,
} from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-26T00:00:00.000Z';
const integration = {
  id: id(1),
  organizationId: id(2),
  provider: 'jira',
  status: 'active',
  displayName: 'Acme Jira',
  externalAccountId: 'cloud-123',
  connectedById: id(3),
  createdAt: now,
  updatedAt: now,
};

describe('v0.7.0 integrations', () => {
  it('is 0.7.0 or later', () => expect(pkg.version).toMatch(/^0\.([7-9]|\d{2,})\.\d+$/));

  it('exposes the route templates', () => {
    expect(INTEGRATION_PATHS.webhook).toBe('/webhooks/:provider/:integrationId');
    expect(INTEGRATION_PATHS.issuePush).toBe(
      '/orgs/:organizationId/tasks/:taskId/integration-issues',
    );
  });

  it('Integration never accepts token or secret fields', () => {
    expect(Value.Check(Integration, integration)).toBe(true);
    for (const k of ['accessToken', 'refreshToken', 'webhookSecret', 'tokenCiphertext'])
      expect(Value.Check(Integration, { ...integration, [k]: 'x' })).toBe(false);
  });

  it('connect returnTo must be a local path', () => {
    expect(
      Value.Check(ConnectIntegrationRequest, {
        provider: 'github',
        returnTo: '/settings/integrations',
      }),
    ).toBe(true);
    expect(
      Value.Check(ConnectIntegrationRequest, { provider: 'github', returnTo: '//evil.example' }),
    ).toBe(false);
    expect(
      Value.Check(ConnectIntegrationRequest, {
        provider: 'github',
        returnTo: 'https://evil.example',
      }),
    ).toBe(false);
    expect(Value.Check(ConnectIntegrationRequest, { provider: 'linear' })).toBe(false);
  });

  it('callback query requires a well-formed state', () => {
    const state = 'a'.repeat(43);
    expect(Value.Check(IntegrationCallbackQuery, { state, code: 'abc' })).toBe(true);
    expect(
      Value.Check(IntegrationCallbackQuery, {
        state,
        installation_id: '12345',
        setup_action: 'install',
      }),
    ).toBe(true);
    expect(Value.Check(IntegrationCallbackQuery, { state: 'short', code: 'abc' })).toBe(false);
    expect(Value.Check(IntegrationCallbackQuery, { state, installation_id: '12a' })).toBe(false);
  });

  it('webhook params and issue push validate', () => {
    expect(Value.Check(WebhookParams, { provider: 'github', integrationId: id(1) })).toBe(true);
    expect(
      Value.Check(PushTaskIssueRequest, {
        integrationId: id(1),
        approvalId: id(2),
        target: 'acme/app',
      }),
    ).toBe(true);
    expect(
      Value.Check(PushTaskIssueRequest, {
        integrationId: id(1),
        approvalId: id(2),
        target: 'PROJ',
      }),
    ).toBe(true);
    expect(
      Value.Check(PushTaskIssueRequest, {
        integrationId: id(1),
        approvalId: id(2),
        target: 'a/b/c',
      }),
    ).toBe(false);
  });

  it('API_ERROR_REASONS includes the integration reasons without duplicates', () => {
    for (const r of INTEGRATION_ERROR_REASONS) expect(API_ERROR_REASONS).toContain(r);
    expect(new Set(API_ERROR_REASONS).size).toBe(API_ERROR_REASONS.length);
  });
});

describe('0.7.0 User.emailVerifiedAt', () => {
  it('accepts an ISO date-time, null, or absence; rejects other values', async () => {
    const { Value } = await import('@sinclair/typebox/value');
    const { User } = await import('../src/domain/org.js');
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'a@example.com',
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    expect(Value.Check(User, base)).toBe(true);
    expect(Value.Check(User, { ...base, emailVerifiedAt: null })).toBe(true);
    expect(Value.Check(User, { ...base, emailVerifiedAt: '2026-10-26T01:00:00.000Z' })).toBe(true);
    expect(Value.Check(User, { ...base, emailVerifiedAt: 'yesterday' })).toBe(false);
  });
});
