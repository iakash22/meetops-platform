import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, redactDeep, DEFAULT_REDACT_KEYS } from '@meetops/logger';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import { devIntegrationsRuntime } from '../src/modules/integrations/runtime.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App } from './helpers.js';

/** #282 coordinator decision 2: OAuth callback routes never log `code` or `state`, whatever their shape. */
const CLOUD = '11111111-2222-4333-8444-555555555555';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = (input instanceof Request ? input.url : input.toString()).split('?')[0];
  const key = `${init?.method ?? 'GET'} ${url}`;
  if (key === 'POST https://auth.atlassian.com/oauth/token')
    return json({
      access_token: 'jira-access',
      refresh_token: 'jira-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read:jira-work write:jira-work read:jira-user offline_access',
    });
  if (key === 'GET https://api.atlassian.com/oauth/token/accessible-resources')
    return json([
      {
        id: CLOUD,
        url: 'https://acme.atlassian.net',
        name: 'Acme',
        scopes: ['read:jira-work', 'write:jira-work'],
      },
    ]);
  return json({ message: 'unexpected' }, 500);
};

describe('OAuth callback logging (#282)', () => {
  let app: App;
  afterEach(async () => app?.close());

  it('hides an error-code-shaped code (ABC_123) and the state in every log line, success and failure', async () => {
    const lines: string[] = [];
    app = await buildApp(
      {
        integrations: new InMemoryIntegrations(),
        integrationsRuntime: devIntegrationsRuntime({
          fetch: fakeFetch,
          jira: { clientId: 'jira-client', clientSecret: async () => 'jira-secret' },
        }),
      } as Partial<ModuleDeps>,
      { logStream: { write: (l: string) => void lines.push(l) } },
    );
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = (await c.post('/orgs', { name: 'Acme' })).json<{ organization: { id: string } }>()
      .organization.id;
    const res = await c.post(`/orgs/${org}/integrations/connect`, { provider: 'jira' });
    const state = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl).searchParams.get(
      'state',
    )!;
    lines.length = 0;

    const ok = await c.get(`/integrations/jira/callback?state=${state}&code=ABC_123`);
    expect(ok.statusCode).toBe(302);
    const forged = 'A'.repeat(43);
    const bad = await c.get(`/integrations/jira/callback?state=${forged}&code=ABC_123`);
    expect(bad.statusCode).toBe(400);
    const gh = await c.get(
      `/integrations/github/callback?state=${forged}&code=XYZ_999&installation_id=99&setup_action=install`,
    );
    expect(gh.statusCode).toBeGreaterThanOrEqual(400);

    const out = lines.join('');
    expect(out).toContain('/integrations/jira/callback?state=***redacted***&code=***redacted***');
    expect(out).not.toMatch(/ABC_123|XYZ_999/);
    expect(out).not.toContain(state);
    expect(out).not.toContain(forged);
  });

  it('a parsed query object is redacted by name even when the value looks like an error code', () => {
    const lines: string[] = [];
    createLogger({ level: 'info' }, { write: (l: string) => void lines.push(l) }).info({
      query: { code: 'ABC_123', state: 'S_1', provider: 'jira' },
      err: { code: 'ECONNREFUSED' },
    });
    expect(lines.join('')).not.toMatch(/ABC_123|S_1/);
    expect(lines.join('')).toContain('ECONNREFUSED');
    expect(
      JSON.stringify(redactDeep({ querystring: { code: 'ABC_123' } }, DEFAULT_REDACT_KEYS)),
    ).not.toContain('ABC_123');
  });
});
