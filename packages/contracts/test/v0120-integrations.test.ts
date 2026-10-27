import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  INTEGRATION_CONNECTION_STATES,
  INTEGRATION_PATHS,
  IntegrationProviderList,
  REDACT_CONDITIONAL_KEYS,
  REDACT_KEYS,
} from '../src/index.js';

describe('v0.12.0 integrations providers', () => {
  it('adds the providers path and connection states', () => {
    expect(INTEGRATION_PATHS.providers).toBe('/orgs/:organizationId/integrations/providers');
    expect(INTEGRATION_CONNECTION_STATES).toEqual(['not_connected', 'active', 'error', 'revoked']);
  });
  it('accepts a not-connected entry and rejects extra fields (no secrets can leak)', () => {
    const ok = {
      items: [{ provider: 'jira', configured: false, connectionStatus: 'not_connected' }],
    };
    expect(Value.Check(IntegrationProviderList, ok)).toBe(true);
    const leak = { items: [{ ...ok.items[0], accessToken: 'x' }] };
    expect(Value.Check(IntegrationProviderList, leak)).toBe(false);
    expect(
      Value.Check(IntegrationProviderList, {
        items: [{ provider: 'slack', configured: true, connectionStatus: 'active' }],
      }),
    ).toBe(false);
  });
  it('redacts integration secrets', () => {
    for (const k of [
      'access_token',
      'refresh_token',
      'clientSecret',
      'webhookSecret',
      'privateKey',
      'webhook_secret',
      'private_key',
      'pem',
      'installationToken',
      'jwt',
      'id_token',
      'GITHUB_APP_CLIENT_SECRET',
      'JIRA_CLIENT_SECRET',
    ])
      expect(REDACT_KEYS).toContain(k);
    expect(REDACT_CONDITIONAL_KEYS).toEqual(['code']);
    expect(REDACT_KEYS as readonly string[]).not.toContain('code');
  });
});

describe('v0.12.0 returnTo pattern (#282 L-2)', () => {
  it('rejects traversal, protocol-relative and encoded separators; accepts app paths', async () => {
    const { ConnectIntegrationRequest } = await import('../src/index.js');
    const ok = (returnTo: string) =>
      Value.Check(ConnectIntegrationRequest, { provider: 'jira', returnTo });
    for (const good of ['/settings/integrations', '/settings/x?tab=a', '/a.b/c', '/.well-known'])
      expect(ok(good), good).toBe(true);
    for (const bad of [
      '/..//evil.com',
      '//evil.com',
      '/a//b',
      '/./x',
      '/a/../b',
      '/a/..',
      '/a/.?x',
      '/%2e%2e/x',
      '/%2F%2Fevil.com',
      '/x?next=//e',
      '/\\evil.com',
      'https://evil.com',
    ])
      expect(ok(bad), bad).toBe(false);
  });
});
