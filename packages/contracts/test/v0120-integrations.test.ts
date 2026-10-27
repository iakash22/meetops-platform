import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  INTEGRATION_CONNECTION_STATES,
  INTEGRATION_PATHS,
  IntegrationProviderList,
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
    ])
      expect(REDACT_KEYS).toContain(k);
  });
});
